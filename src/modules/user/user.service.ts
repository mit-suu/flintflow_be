import { User, IUser, AuthProvider } from "./user.model.js"
import { ApiError } from "../../shared/utils/api-error.js"
import * as sessionService from "../../shared/auth/session.service.js"
import mongoose from "mongoose"
import { CreditWallet } from "../credits/credit-wallet.model.js"
import { Membership } from "../organization/membership.model.js"
import { Organization } from "../organization/organization.model.js"
import { toUserLocale, type UserLocale } from "../../shared/i18n/locale.js"

export interface UserDTO {
  id: string
  email: string
  name?: string
  onboardedAt: Date | null
  createdAt?: Date
  updatedAt?: Date
}

/** `GET /users/me`: thêm các field chỉ chủ tài khoản cần thấy (không lộ qua `GET /users/:id`). */
export interface MeDTO extends UserDTO {
  authProvider: AuthProvider
  emailVerified: boolean
  /** Có mật khẩu để đăng nhập (tài khoản Google thuần thì không) ⇒ FE mới hiện form đổi mật khẩu. */
  hasPassword: boolean
  /** FLF-259: ngôn ngữ giao diện đã lưu; `null` = chưa chọn ⇒ FE lưu ngôn ngữ đang hiển thị. */
  locale: UserLocale | null
  /** FLF-310: credit khả dụng của tổ chức đang chọn (không còn ví cá nhân); chưa chọn tổ chức ⇒ 0. */
  balance: number
  /** FLF-310: tổ chức sở hữu `balance` — FE ghi rõ tên; `null` khi chưa chọn tổ chức. */
  creditOrganization: { id: string; name: string } | null
}

export interface UpdateMeInput {
  name?: string
  onboardedAt?: Date | null
  locale?: UserLocale
}

export const getUserById = async (id: string): Promise<UserDTO> => {
  const user = await User.findById(id).select("-password")
  if (!user) {
    throw new ApiError(404, "Không tìm thấy người dùng.", "USER_NOT_FOUND")
  }

  return {
    id: user._id.toString(),
    email: user.email,
    ...(user.name ? { name: user.name } : {}),
    onboardedAt: user.onboardedAt ?? null,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  }
}

/**
 * FLF-310: credit chỉ nằm ở ví tổ chức — "Credit hiện có" là số dư khả dụng của **tổ chức đang chọn** (cùng ví mà lượt
 * gọi AI trừ, cùng số với trang Thanh toán). Chỉ đọc, không tạo ví: trước đây mở hồ sơ là đẻ thêm một ví cá nhân kèm
 * credit miễn phí. Chưa chọn org / không còn là thành viên ⇒ `null`.
 */
const activeOrgCredit = async (userId: string, orgId: string | null | undefined): Promise<Pick<MeDTO, "balance" | "creditOrganization">> => {
  const none = { balance: 0, creditOrganization: null }
  if (!orgId || !mongoose.isValidObjectId(orgId)) return none
  const [member, org, wallet] = await Promise.all([
    Membership.exists({ organizationId: orgId, userId }),
    Organization.findById(orgId, { name: 1 }).lean(),
    CreditWallet.findOne({ organizationId: orgId }, { balance: 1, reserved: 1 }).lean()
  ])
  if (!member || !org) return none
  return {
    balance: wallet ? wallet.balance - wallet.reserved : 0,
    creditOrganization: { id: String(org._id), name: org.name }
  }
}

/** `activeOrgId`: org đang chọn trong token (`req.user.orgId`). */
export const getMe = async (id: string, activeOrgId?: string | null): Promise<MeDTO> => {
  const [dto, user, credit] = await Promise.all([getUserById(id), User.findById(id).select("+passwordHash"), activeOrgCredit(id, activeOrgId)])
  if (!user) {
    throw new ApiError(404, "Không tìm thấy người dùng.", "USER_NOT_FOUND")
  }
  return {
    ...dto,
    authProvider: user.authProvider,
    emailVerified: user.emailVerified,
    hasPassword: Boolean(user.passwordHash),
    locale: toUserLocale(user.locale),
    ...credit
  }
}

/** UC 1.12 onboarding + FLF-259: cập nhật tên hiển thị, mốc onboarding và/hoặc ngôn ngữ giao diện của chính user. */
export const updateMe = async (id: string, input: UpdateMeInput, activeOrgId?: string | null): Promise<MeDTO> => {
  const user = await User.findByIdAndUpdate(id, { $set: input }, { new: true })
  if (!user) {
    throw new ApiError(404, "Không tìm thấy người dùng.", "USER_NOT_FOUND")
  }
  return getMe(id, activeOrgId)
}

/**
 * Đổi mật khẩu khi đang đăng nhập: phải nhập đúng mật khẩu hiện tại. Thành công thì thu hồi mọi phiên
 * khác, giữ phiên đang dùng (`currentRefreshToken`) để user không bị đăng xuất trên thiết bị này.
 * Sai mật khẩu trả 400 (không phải 401) để FE không hiểu nhầm là hết phiên rồi đi refresh/đăng xuất.
 */
export const changePassword = async (
  id: string,
  currentPassword: string,
  newPassword: string,
  currentRefreshToken?: string
): Promise<void> => {
  const user = await User.findById(id).select("+passwordHash")
  if (!user) {
    throw new ApiError(404, "Không tìm thấy người dùng.", "USER_NOT_FOUND")
  }
  if (!user.passwordHash) {
    throw new ApiError(
      400,
      "Tài khoản đăng nhập bằng Google nên chưa có mật khẩu để đổi.",
      "PASSWORD_NOT_SET"
    )
  }
  if (!(await user.comparePassword(currentPassword))) {
    throw new ApiError(400, "Mật khẩu hiện tại không đúng.", "INVALID_CURRENT_PASSWORD")
  }
  if (currentPassword === newPassword) {
    throw new ApiError(400, "Mật khẩu mới phải khác mật khẩu hiện tại.", "SAME_PASSWORD")
  }

  user.password = newPassword
  await user.save()

  await sessionService.revokeOtherUserSessions(id, currentRefreshToken)
}

export const getUserByEmail = async (email: string): Promise<IUser | null> => {
  return await User.findOne({ email })
}
