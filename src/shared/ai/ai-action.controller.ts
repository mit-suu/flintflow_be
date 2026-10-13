import { Request, Response, NextFunction } from "express"
import { executeAiAction } from "./ai-action.service.js"
import { getActionCost } from "./credit-reservation.service.js"
import { AiActionLog } from "../../modules/admin/ai-action-log.model.js"
import { ApiError } from "../utils/api-error.js"
import { sendSuccess } from "../types/api-response.js"
import { ActionType } from "./ai-action.types.js"
import { withoutDocumentLanguage } from "../i18n/document-language.js"

const VALID_ACTION_TYPES = new Set<string>(Object.values(ActionType))

export const estimateCostHandler = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { actionType } = req.body
    if (!actionType) {
      throw new ApiError(400, "Thiếu loại thao tác AI.", "MISSING_ACTION_TYPE")
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
      throw new ApiError(400, "Thiếu loại thao tác AI.", "MISSING_ACTION_TYPE")
    }

    if (!input) {
      throw new ApiError(400, "Thiếu nội dung để AI xử lý.", "MISSING_INPUT")
    }

    // Chặn trước khi reserve credit: actionType lạ (vd generate_diagram đã gỡ)
    // sẽ reserve rồi mới nổ ở bước nạp template.
    if (!VALID_ACTION_TYPES.has(actionType)) {
      throw new ApiError(400, "Loại thao tác AI không hợp lệ.", "INVALID_ACTION_TYPE")
    }

    // FLF-265 D16: khối "Document language" (trần token gấp đôi + lượt dự phòng) chỉ server bật — bỏ khoá client gửi
    const result = await executeAiAction(
      actionType,
      withoutDocumentLanguage(input),
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
      throw new ApiError(400, "Thiếu thông tin lượt gọi AI cần chạy lại.", "MISSING_LOG_ID")
    }

    const originalLog = await AiActionLog.findById(logId)
    if (!originalLog) {
      throw new ApiError(404, "Không tìm thấy lượt gọi AI cần chạy lại.", "LOG_NOT_FOUND")
    }

    if (originalLog.userId.toString() !== userId) {
      throw new ApiError(403, "Không có quyền thực hiện lại action này", "FORBIDDEN")
    }

    const { input, provider, model } = req.body || {}

    const result = await executeAiAction(
      originalLog.actionType,
      withoutDocumentLanguage(input || { rawPrompt: "Retry previous action" }),
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
