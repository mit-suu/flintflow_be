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
import { JsonStreamExtractor } from "./utils/json-stream-extractor.js"
import { parseResponse } from "./response-parser.js"
import {
  reserveCredit,
  deductCredit,
  releaseCredit,
  getActionCost
} from "./credit-reservation.service.js"
import { executeWithInRequestRetry } from "./retry.service.js"
import { AiActionLog } from "../../modules/admin/ai-action-log.model.js"

export interface ExecuteAiActionOptions {
  provider?: string
  model?: string
  parentLogId?: string
  rawPromptOverride?: string
}

export interface ExecuteAiActionStreamCallbacks<T = any> {
  onTextDelta?: (delta: string) => void | Promise<void>
  onFinish?: (result: AiActionResult<T>) => void | Promise<void>
  onError?: (error: any) => void | Promise<void>
}

export const executeAiAction = async <T = any>(
  actionType: ActionType | string,
  input: AiActionInput,
  projectId: string | undefined,
  userId: string,
  options: ExecuteAiActionOptions = {}
): Promise<AiActionResult<T>> => {
  // Step 1: Calculate cost & Reserve Credit
  const cost = await getActionCost(actionType)

  let session: mongoose.ClientSession | undefined
  try {
    session = await mongoose.startSession()
    session.startTransaction()
    await reserveCredit(userId, actionType, projectId, session)
    await session.commitTransaction()
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
      err?.code === 20
    ) {
      await reserveCredit(userId, actionType, projectId)
    } else {
      throw err
    }
  } finally {
    if (session) {
      session.endSession()
    }
  }

  // Step 2: Build Prompt
  let finalPrompt = ""
  let providerConfig: AiProviderConfig

  if (options.rawPromptOverride || input.rawPrompt) {
    finalPrompt = options.rawPromptOverride || input.rawPrompt || ""
    const loadedTemplate = await getPromptTemplate(actionType)
    providerConfig = {
      ...loadedTemplate.providerConfig,
      ...(options.provider ? { provider: options.provider } : {}),
      ...(options.model ? { model: options.model } : {})
    }
  } else {
    const loadedTemplate = await getPromptTemplate(actionType)
    finalPrompt = interpolatePrompt(loadedTemplate.template, input.promptVariables || input)
    providerConfig = {
      ...loadedTemplate.providerConfig,
      ...(options.provider ? { provider: options.provider } : {}),
      ...(options.model ? { model: options.model } : {})
    }
  }

  // Step 3: Call LLM & Parse Response with In-Request Retry
  let currentLogId: string = ""

  try {
    const result = await executeWithInRequestRetry(async (attempt) => {
      const startTime = Date.now()

      try {
        const llmRes = await callLLM(finalPrompt, providerConfig)
        const latencyMs = Date.now() - startTime

        const parsedData = parseResponse<T>(llmRes.text, actionType)

        // Success: Deduct Credit
        await deductCredit(userId, actionType, cost, projectId)

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
        const latencyMs = Date.now() - startTime
        console.error(`[executeAiAction] Attempt ${attempt + 1} failed for action '${actionType}':`, error.message)
        throw error
      }
    })

    return result
  } catch (finalError: any) {
    // Step 4: On Error -> Release Credit & Record Failed Log
    await releaseCredit(userId, actionType, cost, projectId)

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
  const cost = await getActionCost(actionType)

  let session: mongoose.ClientSession | undefined
  try {
    session = await mongoose.startSession()
    session.startTransaction()
    await reserveCredit(userId, actionType, projectId, session)
    await session.commitTransaction()
  } catch (err: any) {
    if (session) {
      try {
        await session.abortTransaction()
      } catch (_) {}
    }

    if (
      err?.message?.includes("replica set member") ||
      err?.message?.includes("Transaction numbers") ||
      err?.code === 20
    ) {
      await reserveCredit(userId, actionType, projectId)
    } else {
      throw err
    }
  } finally {
    if (session) {
      session.endSession()
    }
  }

  let finalPrompt = ""
  let providerConfig: AiProviderConfig

  if (options.rawPromptOverride || input.rawPrompt) {
    finalPrompt = options.rawPromptOverride || input.rawPrompt || ""
    const loadedTemplate = await getPromptTemplate(actionType)
    providerConfig = {
      ...loadedTemplate.providerConfig,
      ...(options.provider ? { provider: options.provider } : {}),
      ...(options.model ? { model: options.model } : {})
    }
  } else {
    const loadedTemplate = await getPromptTemplate(actionType)
    finalPrompt = interpolatePrompt(loadedTemplate.template, input.promptVariables || {})
    providerConfig = {
      ...loadedTemplate.providerConfig,
      ...(options.provider ? { provider: options.provider } : {}),
      ...(options.model ? { model: options.model } : {})
    }
  }

  const startTime = Date.now()

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

    await deductCredit(userId, actionType, cost, projectId)

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

    const parsedData = parseResponse<T>(fullRaw, actionType)

    // For chat actions, ensure parsedData.reply matches the clean streamed reply
    if (
      (actionType === ActionType.CHAT || actionType === ActionType.CHAT_DISCOVERY) &&
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
    await releaseCredit(userId, actionType, cost, projectId)

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

