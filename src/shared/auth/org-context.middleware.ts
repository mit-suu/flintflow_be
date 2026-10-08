import { Request, Response, NextFunction } from "express"
import mongoose from "mongoose"
import { Membership } from "../../modules/organization/membership.model.js"
import { ApiError } from "../utils/api-error.js"

/**
 * BPMN Flow 10.6 — "Read the membership and the role in that organization", gateway "Member of the
 * organization?" → No ⇒ 403.
 *
 * Nạp lại Membership MỖI REQUEST và không cache. Đó là điều kiện để Flow 9.9 đúng: người vừa bị xoá khỏi
 * org (UC-74) hoặc vừa bị đổi vai trò (UC-73) làm việc với quyền mới "from their next request" — nếu cache
 * hoặc nhét role vào token thì họ giữ quyền cũ tới khi token hết hạn.
 *
 * Token không mang `orgId` ⇒ 409 NO_ACTIVE_ORG: tài khoản chưa onboarding (Flow 8) hoặc chưa chọn org
 * (Flow 7.13). FE bắt mã này để đẩy về màn tạo / vào org, khác hẳn 403 là "có org nhưng không được vào".
 */
/** Nạp membership và gắn vào req.orgContext. Trả false khi người này không thuộc org. */
const loadMembership = async (req: Request, userId: string, orgId: string): Promise<boolean> => {
  const membership = await Membership.findOne({ organizationId: orgId, userId })
    .select("_id role")
    .lean()
  if (!membership) return false
  req.orgContext = { orgId, role: membership.role, membershipId: String(membership._id) }
  return true
}

/**
 * Cùng việc như `orgContext` nhưng lấy orgId từ URL (`/orgs/:orgId/...`) thay vì từ token — dùng cho các
 * route QUẢN LÝ org, nơi người dùng thao tác lên một org không nhất thiết là org đang mở.
 *
 * Không phải thành viên ⇒ **404**, không phải 403: org của người khác thì không nên lộ ra là có tồn tại.
 * (`orgContext` trả 403 vì ở đó orgId đến từ token do chính hệ thống cấp.)
 */
export const orgContextFromParam =
  (param = "orgId") =>
  async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.user?.userId
      if (!userId) {
        throw new ApiError(401, "Chưa xác thực người dùng", "UNAUTHORIZED")
      }
      const raw = req.params[param]
      const orgId = typeof raw === "string" ? raw : undefined
      if (!orgId || !mongoose.isValidObjectId(orgId)) {
        throw new ApiError(404, "Không tìm thấy tổ chức", "ORG_NOT_FOUND")
      }
      if (!(await loadMembership(req, userId, orgId))) {
        throw new ApiError(404, "Không tìm thấy tổ chức", "ORG_NOT_FOUND")
      }
      next()
    } catch (error) {
      next(error)
    }
  }

export const orgContext = async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user?.userId
    if (!userId) {
      throw new ApiError(401, "Chưa xác thực người dùng", "UNAUTHORIZED")
    }

    const orgId = req.user?.orgId
    if (!orgId || !mongoose.isValidObjectId(orgId)) {
      throw new ApiError(409, "Chưa chọn tổ chức để làm việc", "NO_ACTIVE_ORG")
    }

    if (!(await loadMembership(req, userId, orgId))) {
      throw new ApiError(403, "Bạn không thuộc tổ chức này", "ORG_FORBIDDEN")
    }
    next()
  } catch (error) {
    next(error)
  }
}
