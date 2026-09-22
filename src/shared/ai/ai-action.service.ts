import mongoose from "mongoose"
import { streamText } from "ai"
import {
  ActionType,
  AiActionInput,
  AiActionResult,
  AiProviderConfig,
  AiActionError
} from "./ai-action.types.js"
import { getPromptTemplate, interpolatePrompt } from "./prompt-registry.service.js"
import { callLLM } from "./providers/llm.router.js"
import { getAiSdkModel } from "./providers/ai-sdk.provider.js"
import { stripReasoning } from "./providers/glm.provider.js"
import { JsonStreamExtractor } from "./utils/json-stream-extractor.js"
import { parseResponse } from "./response-parser.js"
import {
  reserveCredit,
  deductCredit,
  releaseCredit,
  CreditReservation
} from "./credit-reservation.service.js"
import { executeWithInRequestRetry } from "./retry.service.js"
import { AiActionLog } from "../../modules/admin/ai-action-log.model.js"

export interface ExecuteAiActionOptions {
  provider?: string
  model?: string
  parentLogId?: string
  rawPromptOverride?: string
  /**
   * FLF-177 WP-4 (BUG-05): huỷ lượt chạy step phải huỷ luôn request HTTP đang mở tới provider. Không có
   * nó thì khoá step vẫn bị giữ cho tới khi model soạn xong (có lúc tới 20 phút).
   */
  signal?: AbortSignal
}

export interface ExecuteAiActionStreamCallbacks<T = any> {
  onTextDelta?: (delta: string) => void | Promise<void>
  onFinish?: (result: AiActionResult<T>) => void | Promise<void>
  onError?: (error: any) => void | Promise<void>
}

const reserveCreditWithTransaction = async (
  userId: string,
  actionType: string,
  projectId: string | undefined
): Promise<CreditReservation> => {
  let session: mongoose.ClientSession | undefined
  try {
    session = await mongoose.startSession()
    session.startTransaction()
    const reservation = await reserveCredit(userId, actionType, projectId, session)
    await session.commitTransaction()
    return reservation
  } catch (err: any) {
    if (session) {
      try {
        await session.abortTransaction()
      } catch (_) {}
    }

    // Fallback if standalone MongoDB does not support transactions
    if (
      err?.message?.includes("replica set member") ||
      err?.message?.includes("Transaction numbers") ||
      err?.message?.includes("retryable writes") ||
      err?.code === 20
    ) {
      return reserveCredit(userId, actionType, projectId)
    }
    throw err
  } finally {
    if (session) {
      session.endSession()
    }
  }
}

/** Release không được che lỗi gốc của action: lỗi release chỉ log. */
const releaseQuietly = async (reservation: CreditReservation): Promise<void> => {
  try {
    await releaseCredit(reservation)
  } catch (releaseError) {
    console.error(
      `[executeAiAction] Release credit failed for reservation ${reservation.reservationId}:`,
      releaseError
    )
  }
}

const buildPrompt = async (
  actionType: string,
  input: AiActionInput,
  options: ExecuteAiActionOptions,
  fallbackVariables: Record<string, any>
): Promise<{ finalPrompt: string; providerConfig: AiProviderConfig }> => {
  const loadedTemplate = await getPromptTemplate(actionType)
  const finalPrompt =
    options.rawPromptOverride || input.rawPrompt
      ? options.rawPromptOverride || input.rawPrompt || ""
      : interpolatePrompt(loadedTemplate.template, input.promptVariables || fallbackVariables)

  return {
    finalPrompt,
    providerConfig: {
      ...loadedTemplate.providerConfig,
      ...(options.provider ? { provider: options.provider } : {}),
      ...(options.model ? { model: options.model } : {}),
      // Provider mock cần biết đang được hỏi gì để trả output đúng schema của ActionType đó (T24).
      actionType: String(actionType)
    }
  }
}

export const executeAiAction = async <T = any>(
  actionType: ActionType | string,
  input: AiActionInput,
  projectId: string | undefined,
  userId: string,
  options: ExecuteAiActionOptions = {}
): Promise<AiActionResult<T>> => {
  // Step 1: Reserve Credit
  const reservation = await reserveCreditWithTransaction(userId, actionType, projectId)
  const cost = reservation.cost

  // Step 2: Build Prompt
  let finalPrompt: string
  let providerConfig: AiProviderConfig
  try {
    ;({ finalPrompt, providerConfig } = await buildPrompt(actionType, input, options, input))
  } catch (buildError) {
    await releaseQuietly(reservation)
    throw buildError
  }

  // Step 3: Call LLM & Parse Response with In-Request Retry.
  // Thứ tự bắt buộc: parse → deduct. `deducted` chặn trừ hai lần khi retry và
  // chặn release sau khi đã trừ (lỗi ghi log phía sau không được hoàn tiền).
  let deducted = false
  let currentLogId: string = ""

  try {
    const result = await executeWithInRequestRetry(async (attempt) => {
      const startTime = Date.now()

      try {
        if (options.signal?.aborted) throw new AiActionError(499, "Lượt chạy đã bị huỷ", "RUN_CANCELLED")
        const llmRes = await callLLM(finalPrompt, providerConfig, options.signal)
        const latencyMs = Date.now() - startTime

        const parsedData = parseResponse<T>(llmRes.text, actionType)

        // Success: Deduct Credit (chỉ sau khi parse thành công)
        if (!deducted) {
          await deductCredit(reservation)
          deducted = true
        }

        // Create success log
        const logDoc = await AiActionLog.create({
          projectId: projectId ? new mongoose.Types.ObjectId(projectId) : null,
          userId: new mongoose.Types.ObjectId(userId),
          actionType,
          provider: providerConfig.provider,
          aiModel: providerConfig.model,
          status: "success",
          promptTokens: llmRes.promptTokens,
          completionTokens: llmRes.completionTokens,
          latencyMs,
          retryOfLogId: options.parentLogId ? new mongoose.Types.ObjectId(options.parentLogId) : null
        })

        currentLogId = logDoc._id.toString()

        return {
          success: true,
          data: parsedData,
          rawText: llmRes.text,
          actionType: actionType as ActionType,
          provider: providerConfig.provider,
          aiModel: providerConfig.model,
          tokensUsed: {
            promptTokens: llmRes.promptTokens,
            completionTokens: llmRes.completionTokens,
            totalTokens: llmRes.promptTokens + llmRes.completionTokens
          },
          latencyMs,
          logId: currentLogId,
          cost
        }
      } catch (error: any) {
        console.error(`[executeAiAction] Attempt ${attempt + 1} failed for action '${actionType}':`, error.message)
        throw error
      }
    })

    return result
  } catch (finalError: any) {
    // Step 4: On Error -> Release Credit (chỉ khi chưa trừ) & Record Failed Log
    if (!deducted) {
      await releaseQuietly(reservation)
    }

    const failedLog = await AiActionLog.create({
      projectId: projectId ? new mongoose.Types.ObjectId(projectId) : null,
      userId: new mongoose.Types.ObjectId(userId),
      actionType,
      provider: providerConfig.provider,
      aiModel: providerConfig.model,
      status: "failed",
      errorMessage: finalError.message || "AI Action execution failed",
      retryOfLogId: options.parentLogId ? new mongoose.Types.ObjectId(options.parentLogId) : null
    })

    if (finalError instanceof AiActionError) {
      finalError.details = { ...finalError.details, logId: failedLog._id.toString() }
      throw finalError
    }

    throw new AiActionError(
      500,
      finalError.message || "Thực thi AI Action thất bại",
      "AI_EXECUTION_FAILED",
      { logId: failedLog._id.toString() }
    )
  }
}

export const executeAiActionStream = async <T = any>(
  actionType: ActionType | string,
  input: AiActionInput,
  projectId: string | undefined,
  userId: string,
  callbacks: ExecuteAiActionStreamCallbacks<T> = {},
  options: ExecuteAiActionOptions = {}
): Promise<AiActionResult<T>> => {
  const reservation = await reserveCreditWithTransaction(userId, actionType, projectId)
  const cost = reservation.cost

  let finalPrompt: string
  let providerConfig: AiProviderConfig
  try {
    ;({ finalPrompt, providerConfig } = await buildPrompt(actionType, input, options, {}))
  } catch (buildError) {
    await releaseQuietly(reservation)
    throw buildError
  }

  const startTime = Date.now()
  let deducted = false

  try {
    const model = getAiSdkModel(providerConfig)
    const streamResult = streamText({
      model,
      prompt: finalPrompt,
      temperature: providerConfig.temperature ?? 0.7,
      maxOutputTokens: providerConfig.maxTokens ?? 2048
    })

    const extractor = new JsonStreamExtractor()

    for await (const chunk of streamResult.textStream) {
      const delta = extractor.push(chunk)
      if (delta && callbacks.onTextDelta) {
        await callbacks.onTextDelta(delta)
      }
    }

    const { reply: streamedReply, fullRaw } = extractor.finish()
    const latencyMs = Date.now() - startTime

    let promptTokens = Math.ceil(finalPrompt.length / 4)
    let completionTokens = Math.ceil(fullRaw.length / 4)
    try {
      const usage = await streamResult.usage
      if ((usage as any)?.inputTokens) promptTokens = (usage as any).inputTokens
      else if ((usage as any)?.promptTokens) promptTokens = (usage as any).promptTokens
      if ((usage as any)?.outputTokens) completionTokens = (usage as any).outputTokens
      else if ((usage as any)?.completionTokens) completionTokens = (usage as any).completionTokens
    } catch (_) {}

    // Parse TRƯỚC, deduct SAU: output hỏng thì không tính phí (audit E2)
    const parsedData = parseResponse<T>(stripReasoning(fullRaw), actionType)

    await deductCredit(reservation)
    deducted = true

    const logDoc = await AiActionLog.create({
      projectId: projectId ? new mongoose.Types.ObjectId(projectId) : null,
      userId: new mongoose.Types.ObjectId(userId),
      actionType,
      provider: providerConfig.provider,
      aiModel: providerConfig.model,
      status: "success",
      promptTokens,
      completionTokens,
      latencyMs,
      retryOfLogId: options.parentLogId ? new mongoose.Types.ObjectId(options.parentLogId) : null
    })

    // For chat actions, ensure parsedData.reply matches the clean streamed reply
    if (
      actionType === ActionType.CHAT &&
      parsedData &&
      typeof (parsedData as any) === "object" &&
      streamedReply
    ) {
      if (!(parsedData as any).reply || (parsedData as any).reply.startsWith("{")) {
        (parsedData as any).reply = streamedReply
      }
    }

    const result: AiActionResult<T> = {
      success: true,
      data: parsedData,
      rawText: fullRaw,
      actionType: actionType as ActionType,
      provider: providerConfig.provider,
      aiModel: providerConfig.model,
      tokensUsed: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens
      },
      latencyMs,
      logId: (logDoc as any)._id.toString(),
      cost
    }

    if (callbacks.onFinish) {
      await callbacks.onFinish(result)
    }

    return result
  } catch (finalError: any) {
    if (!deducted) {
      await releaseQuietly(reservation)
    }

    const failedLog = await AiActionLog.create({
      projectId: projectId ? new mongoose.Types.ObjectId(projectId) : null,
      userId: new mongoose.Types.ObjectId(userId),
      actionType,
      provider: providerConfig.provider,
      aiModel: providerConfig.model,
      status: "failed",
      errorMessage: finalError.message || "AI Action stream execution failed",
      retryOfLogId: options.parentLogId ? new mongoose.Types.ObjectId(options.parentLogId) : null
    })

    if (callbacks.onError) {
      await callbacks.onError(finalError)
    }

    if (finalError instanceof AiActionError) {
      finalError.details = { ...finalError.details, logId: failedLog._id.toString() }
      throw finalError
    }

    throw new AiActionError(
      500,
      finalError.message || "Thực thi AI Action Stream thất bại",
      "AI_STREAM_EXECUTION_FAILED",
      { logId: failedLog._id.toString() }
    )
  }
}
