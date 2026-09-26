import type { Request } from "express"
import { ApiError } from "../utils/api-error.js"

/**
 * Org đang mở của request (task-26 Pha 4). `orgContext` đã gắn nó ở tầng app cho mọi route tài nguyên
 * của org, nên thiếu ở đây là lỗi cấu hình route chứ không phải lỗi người dùng — ném 500 để lộ ra ngay
 * thay vì âm thầm cho qua bằng một giá trị rỗng.
 */
export const requireOrgId = (req: Request): string => {
  const orgId = req.orgContext?.orgId
  if (!orgId) throw new ApiError(500, "Route thiếu orgContext", "ORG_CONTEXT_MISSING")
  return orgId
}
