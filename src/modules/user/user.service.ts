import { User, IUser } from "./user.model.js"
import { ApiError } from "../../shared/utils/api-error.js"
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

/** UC 1.12 onboarding: cập nhật tên hiển thị và/hoặc mốc onboarding của chính user. */
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
