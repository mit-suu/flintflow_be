import { User } from "../models/user.model.js"
import { ApiError } from "../utils/ApiError.js"
import { HTTP_STATUS } from "../constants/http-status.js"
import { UserResponseDTO } from "../dtos/user/user-response.dto.js"

export const getUserById = async (userId: string): Promise<UserResponseDTO> => {
  const user = await User.findById(userId)
  if (!user) {
    throw new ApiError(HTTP_STATUS.NOT_FOUND, "User not found")
  }

  return {
    id: user._id.toString(),
    email: user.email,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  }
}

export const getUserByEmail = async (email: string): Promise<UserResponseDTO> => {
  const user = await User.findOne({ email })
  if (!user) {
    throw new ApiError(HTTP_STATUS.NOT_FOUND, "User not found")
  }

  return {
    id: user._id.toString(),
    email: user.email,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  }
}
