import { User, IUser } from "./user.model.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { getOrCreateWallet } from "../../shared/ai/credit-reservation.service.js"

export interface UserDTO {
  id: string
  email: string
  balance?: number
  createdAt?: Date
  updatedAt?: Date
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
    balance,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  }
}

export const getUserByEmail = async (email: string): Promise<IUser | null> => {
  return await User.findOne({ email })
}
