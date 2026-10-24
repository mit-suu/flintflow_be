import { Request, Response, NextFunction } from "express"
import { ApiError } from "../utils/api-error.js"

/**
 * Viewer chỉ ĐỌC được bản dành cho người xem (UC-47/48/50/51, UC-20): tài liệu, version, so sánh, tải bản đã
 * phát hành, tiến độ, truy vết, comment. Spine, cờ, lịch sử change, nguồn/tài liệu tham chiếu, chat, change request,
 * lượt chạy step, import/gap report là dữ liệu làm việc của Analyst/Lead — Viewer gọi API thẳng cũng không được đọc.
 *
 * Allowlist (không phải denylist) để route GET mới mặc định bị chặn với Viewer, giống lý do của `viewerReadOnly`.
 * Đường dẫn so với tiền tố mount `/api/v1/projects`. Lọc nội dung (ẩn cờ, giả định…) do từng controller làm qua
 * `isViewer`.
 */
export const VIEWER_READ_ALLOW: readonly RegExp[] = [
  /^\/?$/, // danh sách dự án
  /^\/[^/]+$/, // chi tiết dự án
  /^\/[^/]+\/document$/,
  /^\/[^/]+\/export\/word$/,
  /^\/[^/]+\/diagrams(\/[^/]+)?$/,
  /^\/[^/]+\/baselines$/,
  /^\/[^/]+\/versions$/,
  /^\/[^/]+\/versions\/compare$/,
  /^\/[^/]+\/versions\/[^/]+\/(blocks|download)$/,
  /^\/[^/]+\/progress$/,
  /^\/[^/]+\/traceability$/,
  /^\/[^/]+\/comments$/
]

const READ_METHODS = new Set(["GET", "HEAD"])

export const isViewer = (req: Request): boolean => req.orgContext?.role === "viewer"

export const viewerReadScope =
  (allow: readonly RegExp[] = VIEWER_READ_ALLOW) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    if (!READ_METHODS.has(req.method) || !isViewer(req)) return next()
    if (allow.some((pattern) => pattern.test(req.path))) return next()
    next(new ApiError(403, "Viewer chỉ xem được tài liệu đã chia sẻ, không xem được dữ liệu làm việc này", "ORG_ROLE_FORBIDDEN"))
  }
