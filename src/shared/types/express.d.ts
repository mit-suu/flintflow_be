import { TokenPayload } from "../auth/jwt.util.js"
import type { OrgRole } from "../../modules/organization/membership.model.js"

/** Tài khoản đọc từ DB mỗi request (BPMN Flow 10.4) — không tin role trong token. */
export interface AccountContext {
  userId: string
  email: string
  /** Vai trò nền tảng: user | admin. */
  role: string
  isActive: boolean
}

/** Tư cách thành viên trong org đang mở, nạp lại mỗi request (BPMN Flow 10.6). */
export interface OrgContext {
  orgId: string
  role: OrgRole
  membershipId: string
}

declare global {
  namespace Express {
    interface Request {
      user?: TokenPayload
      account?: AccountContext
      orgContext?: OrgContext
    }
  }
}
