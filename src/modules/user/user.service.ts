import { User, IUser } from "./user.model.js"
import { ApiError } from "../../shared/utils/api-error.js"

export interface UserDTO {
  id: string
  email: string
  createdAt?: Date
  updatedAt?: Date
}

export const getUserById = async (id: string): Promise<UserDTO> => {
  const user = await User.findById(id).select("-password")
  if (!user) {
    throw new ApiError(404, "User not found", "USER_NOT_FOUND")
  }
  return {
    id: user._id.toString(),
    email: user.email,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  }
}

export const getUserByEmail = async (email: string): Promise<IUser | null> => {
  return await User.findOne({ email })
}
