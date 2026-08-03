import mongoose from "mongoose"
import {
  ActionType,
  AiActionInput,
  AiActionResult,
  AiProviderConfig,
  AiActionError
} from "./ai-action.types.js"
import { getPromptTemplate, interpolatePrompt } from "./prompt-registry.service.js"
import { callLLM } from "./providers/llm.router.js"
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
