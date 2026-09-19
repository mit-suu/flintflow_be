import { Request, Response, NextFunction } from "express"
import { ApiError } from "../utils/api-error.js"
import { sendError } from "../types/api-response.js"

export const errorHandler = (
  err: Error | ApiError,
  _req: Request,
  res: Response,
  _next: NextFunction
): Response => {
  console.error("[ERROR]", err)

  if (err instanceof ApiError) {
    // Lỗi mang `meta` (vd mode 1: CHANGE_REQUIRES_CR { prefill }) giữ nguyên trong envelope — FLF-171
    const meta = "meta" in err && err.meta && typeof err.meta === "object" ? (err.meta as Record<string, unknown>) : undefined
    return sendError(res, err.statusCode, err.code, err.message, meta)
  }

  // Handle Mongoose or JSON parse errors
  const statusCode = (err as any).statusCode || 500
  const message = err.message || "Internal Server Error"
  const code = (err as any).code || (statusCode === 500 ? "INTERNAL_SERVER_ERROR" : "BAD_REQUEST")

  return sendError(res, statusCode, String(code), message)
}
