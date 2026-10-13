import { Request, Response, NextFunction } from "express"
import { ApiError } from "../utils/api-error.js"

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

/**
 * Viewer CHỈ ĐỌC (`context/actors-and-use-cases.md`: Viewer đọc tài liệu, phiên bản, truy vết, tiến độ, tải
 * `.docx`; "cannot run AI steps or change content"). Đứng sau `orgContext` (cần `req.orgContext.role`).
 *
 * Mount một lần ở tầng app theo tiền tố thay vì gắn `requireRole` vào từng route: trước đây chỉ pipeline, chat và
 * xoá dự án chặn vai trò, còn ~50 endpoint ghi khác (sửa qua chat, change request, import, release, baseline, waive
 * cờ, đổi tên dự án, thư mục…) Viewer gọi API thẳng vẫn ghi được — gắn tay từng route thì chắc chắn sót, route mới
 * cũng sẽ sót.
 *
 * `allow`: các thao tác ghi về kỹ thuật nhưng chỉ phục vụ việc ĐỌC (so với `req.path`, tương đối với tiền tố
 * mount). Comment và trả lời comment (UC-49 — Viewer được để lại comment) nằm trong allowlist ở `app.ts`.
 */
export const viewerReadOnly =
  (allow: readonly RegExp[] = []) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    if (READ_METHODS.has(req.method)) return next()
    if (req.orgContext?.role !== "viewer") return next()
    if (allow.some((pattern) => pattern.test(req.path))) return next()
    next(new ApiError(403, "Viewer chỉ xem được, không thay đổi nội dung", "ORG_ROLE_FORBIDDEN"))
  }
