import { User, IUser } from "../models/user.model.js"
import { ApiError } from "../utils/ApiError.js"
import { generateAccessToken, generateRefreshToken, TokenPayload } from "../utils/generate-token.js"
import { AuthResponseDTO } from "../dtos/auth/auth-response.dto.js"
import { HTTP_STATUS } from "../constants/http-status.js"

export const register = async (email: string, password: string): Promise<AuthResponseDTO> => {
  // Check if user already exists
  const existingUser = await User.findOne({ email })
  if (existingUser) {
    throw new ApiError(HTTP_STATUS.CONFLICT, "Email already registered")
  }

  // Create new user
  const user = await User.create({ email, password })

  // Generate tokens
  const tokenPayload: TokenPayload = {
    userId: user._id.toString(),
    email: user.email
  }
  const accessToken = generateAccessToken(tokenPayload)
  const refreshToken = generateRefreshToken(tokenPayload)

  // Store refresh token (hash it in production)
  user.refreshToken = refreshToken
  await user.save()

  return {
    accessToken,
    user: {
      id: user._id.toString(),
      email: user.email
    }
  }
}

export const login = async (email: string, password: string): Promise<AuthResponseDTO> => {
  // Find user and get password field
  const user = await User.findOne({ email }).select("+password")
  if (!user) {
    throw new ApiError(HTTP_STATUS.UNAUTHORIZED, "Invalid credentials")
  }

  // Compare password
  const isPasswordValid = await user.comparePassword(password)
  if (!isPasswordValid) {
    throw new ApiError(HTTP_STATUS.UNAUTHORIZED, "Invalid credentials")
  }

  // Generate tokens
  const tokenPayload: TokenPayload = {
    userId: user._id.toString(),
    email: user.email
  }
  const accessToken = generateAccessToken(tokenPayload)
  const refreshToken = generateRefreshToken(tokenPayload)

  // Store refresh token
  user.refreshToken = refreshToken
  await user.save()

  return {
    accessToken,
    user: {
      id: user._id.toString(),
      email: user.email
    }
  }
}

export const logout = async (userId: string): Promise<void> => {
  await User.findByIdAndUpdate(userId, { refreshToken: null })
}
