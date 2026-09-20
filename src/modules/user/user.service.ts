import { User, IUser, AuthProvider } from "./user.model.js"
import { ApiError } from "../../shared/utils/api-error.js"
import * as sessionService from "../../shared/auth/session.service.js"
import { getOrCreateWallet } from "../../shared/ai/credit-reservation.service.js"

export interface UserDTO {
  id: string
  email: string
  name?: string
  onboardedAt: Date | null
  balance?: number
  createdAt?: Date
  updatedAt?: Date
}

/** `GET /users/me`: thêm các field chỉ chủ tài khoản cần thấy (không lộ qua `GET /users/:id`). */
export interface MeDTO extends UserDTO {
  authProvider: AuthProvider
  emailVerified: boolean
  /** Có mật khẩu để đăng nhập (tài khoản Google thuần thì không) ⇒ FE mới hiện form đổi mật khẩu. */
  hasPassword: boolean
}

export interface UpdateMeInput {
  name?: string
  onboardedAt?: Date | null
}

export const getUserById = async (id: string): Promise<UserDTO> => {
  const user = await User.findById(id).select("-password")
  if (!user) {
    throw new ApiError(404, "User not found", "USER_NOT_FOUND")
  }
  
  let balance = 0
  try {
    const wallet = await getOrCreateWallet(user._id.toString())
    balance = wallet.balance
  } catch (error) {
    console.error("Failed to get/create credit wallet for user", user._id, error)
  }

  return {
    id: user._id.toString(),
    email: user.email,
    ...(user.name ? { name: user.name } : {}),
    onboardedAt: user.onboardedAt ?? null,
    balance,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  }
}

export const getMe = async (id: string): Promise<MeDTO> => {
  const [dto, user] = await Promise.all([getUserById(id), User.findById(id).select("+passwordHash")])
  if (!user) {
    throw new ApiError(404, "User not found", "USER_NOT_FOUND")
  }
  return {
    ...dto,
    authProvider: user.authProvider,
    emailVerified: user.emailVerified,
    hasPassword: Boolean(user.passwordHash)
  }
}

/** UC 1.12 onboarding: cập nhật tên hiển thị và/hoặc mốc onboarding của chính user. */
export const updateMe = async (id: string, input: UpdateMeInput): Promise<MeDTO> => {
  const user = await User.findByIdAndUpdate(id, { $set: input }, { new: true })
  if (!user) {
    throw new ApiError(404, "User not found", "USER_NOT_FOUND")
  }
  return getMe(id)
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
    throw new ApiError(404, "User not found", "USER_NOT_FOUND")
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
