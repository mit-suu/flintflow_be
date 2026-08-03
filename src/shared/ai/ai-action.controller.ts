import { Request, Response, NextFunction } from "express"
import { executeAiAction } from "./ai-action.service.js"
import { getActionCost } from "./credit-reservation.service.js"
import { AiActionLog } from "../../modules/admin/ai-action-log.model.js"
import { ApiError } from "../utils/api-error.js"
import { sendSuccess } from "../types/api-response.js"

export const estimateCostHandler = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { actionType } = req.body
    if (!actionType) {
      throw new ApiError(400, "actionType là bắt buộc", "MISSING_ACTION_TYPE")
    }

    const cost = await getActionCost(actionType)
    return sendSuccess(res, 200, { actionType, cost })
  } catch (error) {
    next(error)
  }
}

export const executeAiActionHandler = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = (req as any).user?.id || (req as any).user?.userId
    if (!userId) {
      throw new ApiError(401, "Chưa xác thực người dùng", "UNAUTHORIZED")
    }

    const { actionType, input, projectId, provider, model } = req.body

    if (!actionType) {
      throw new ApiError(400, "actionType là bắt buộc", "MISSING_ACTION_TYPE")
    }

    if (!input) {
      throw new ApiError(400, "input là bắt buộc", "MISSING_INPUT")
    }

    const result = await executeAiAction(
      actionType,
      input,
      projectId,
      userId,
      { provider, model }
    )

    return sendSuccess(res, 200, result)
  } catch (error) {
    next(error)
  }
}

export const retryAiActionHandler = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = (req as any).user?.id || (req as any).user?.userId
    if (!userId) {
      throw new ApiError(401, "Chưa xác thực người dùng", "UNAUTHORIZED")
    }

    const logId = Array.isArray(req.params.logId) ? req.params.logId[0] : req.params.logId
    if (!logId) {
      throw new ApiError(400, "logId là bắt buộc", "MISSING_LOG_ID")
    }

    const originalLog = await AiActionLog.findById(logId)
    if (!originalLog) {
      throw new ApiError(404, "Không tìm thấy AiActionLog", "LOG_NOT_FOUND")
    }

    if (originalLog.userId.toString() !== userId) {
      throw new ApiError(403, "Không có quyền thực hiện lại action này", "FORBIDDEN")
    }

    const { input, provider, model } = req.body || {}

    const result = await executeAiAction(
      originalLog.actionType,
      input || { rawPrompt: "Retry previous action" },
      originalLog.projectId?.toString(),
      userId,
      {
        provider: provider || originalLog.provider,
        model: model || originalLog.aiModel,
        parentLogId: logId
      }
    )

    return sendSuccess(res, 200, result)
  } catch (error) {
    next(error)
  }
}
