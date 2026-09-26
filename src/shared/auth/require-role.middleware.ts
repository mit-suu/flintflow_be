import { Request, Response, NextFunction } from "express"
import type { OrgRole } from "../../modules/organization/membership.model.js"
import { ApiError } from "../utils/api-error.js"

/**
 * BPMN Flow 10.7 — "Match the role against the action (Lead / Analyst / Viewer)", gateway "Does the role
 * allow the action?" → No ⇒ 403.
 *
 * Dùng sau `orgContext`. Ví dụ theo bảng vai trò ở business-flow.md §2:
 *   requireRole("lead")               — duyệt baseline, quản lý thành viên, mua credit, xoá project
 *   requireRole("lead", "analyst")    — chạy step AI, soạn nội dung (Viewer bị chặn ở đây)
 */
export const requireRole =
  (...allowed: OrgRole[]) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    const role = req.orgContext?.role
    if (!role) {
      // Lỗi cấu hình route, không phải lỗi của người dùng: thiếu `orgContext` đứng trước.
      next(new ApiError(500, "requireRole phải đứng sau orgContext", "ORG_CONTEXT_MISSING"))
      return
    }
    if (!allowed.includes(role)) {
      next(new ApiError(403, "Vai trò của bạn không được phép thực hiện thao tác này", "ORG_ROLE_FORBIDDEN"))
      return
    }
    next()
  }
