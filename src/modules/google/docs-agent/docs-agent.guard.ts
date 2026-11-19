import type { NextFunction, Request, Response } from "express"
import { env } from "../../../config/env.js"
import { ApiError } from "../../../shared/utils/api-error.js"

export const GOOGLE_DOCS_AGENT_DISABLED = "GOOGLE_DOCS_AGENT_DISABLED"

/**
 * Chặn trợ lý Google Docs và endpoint MCP khi `GOOGLE_DOCS_AGENT_ENABLED` tắt (mặc định). Trợ lý sửa thẳng file trên
 * Google Docs mà không qua tài liệu trong FlintFlow, nên hai bản lệch nhau và lần xuất "cập nhật" sau ghi đè mất chỗ sửa.
 * Đọc `env` mỗi request để test bật / tắt được không cần nạp lại module.
 */
export const requireDocsAgentEnabled = (_req: Request, _res: Response, next: NextFunction): void => {
  if (!env.GOOGLE_DOCS_AGENT_ENABLED) {
    next(new ApiError(503, "Trợ lý Google Docs chưa được bật trên hệ thống.", GOOGLE_DOCS_AGENT_DISABLED))
    return
  }
  next()
}
