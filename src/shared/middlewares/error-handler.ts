import { Request, Response, NextFunction } from "express"
import { ApiError } from "../utils/api-error.js"
import { sendError } from "../types/api-response.js"
import { toClientError } from "../utils/client-error.js"

export const errorHandler = (
  err: Error | ApiError,
  _req: Request,
  res: Response,
  _next: NextFunction
): Response => {
  // Log đủ chi tiết kỹ thuật ở server; client chỉ nhận câu người đọc được (FLF-247).
  console.error("[ERROR]", err)

  // Lỗi mang `meta` (vd mode 1: CHANGE_REQUIRES_CR { prefill }) giữ nguyên trong envelope — FLF-171
  const { status, code, message, meta } = toClientError(err)
  return sendError(res, status, code, message, meta)
}

/** Không route nào khớp — trả envelope JSON thay cho trang HTML "Cannot GET …" mặc định của Express. */
export const notFoundHandler = (_req: Request, res: Response): Response =>
  sendError(res, 404, "NOT_FOUND", "Không tìm thấy địa chỉ yêu cầu.")
