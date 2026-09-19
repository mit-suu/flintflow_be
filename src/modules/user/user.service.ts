import { DEFAULT_USER_LOCALE, User, IUser, type UserLocale } from "./user.model.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { getOrCreateWallet } from "../../shared/ai/credit-reservation.service.js"

export interface UserDTO {
  id: string
  email: string
  name?: string
  onboardedAt: Date | null
  locale: UserLocale
  balance?: number
  createdAt?: Date
  updatedAt?: Date
}

export interface UpdateMeInput {
  name?: string
  onboardedAt?: Date | null
  locale?: UserLocale
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
    // User tạo trước T25 chưa có field ⇒ mặc định tiếng Việt
    locale: user.locale ?? DEFAULT_USER_LOCALE,
    balance,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  }
}

/** UC 1.12 onboarding + T25: cập nhật tên hiển thị, mốc onboarding và/hoặc ngôn ngữ của chính user. */
export const updateMe = async (id: string, input: UpdateMeInput): Promise<UserDTO> => {
  const user = await User.findByIdAndUpdate(id, { $set: input }, { new: true })
  if (!user) {
    throw new ApiError(404, "User not found", "USER_NOT_FOUND")
  }
  return getUserById(id)
}

export const getUserByEmail = async (email: string): Promise<IUser | null> => {
  return await User.findOne({ email })
}
