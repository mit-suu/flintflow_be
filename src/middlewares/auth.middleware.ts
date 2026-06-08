import { Request, Response, NextFunction } from "express"
import { ApiError } from "../utils/ApiError.js"
import { verifyAccessToken, TokenPayload } from "../utils/generate-token.js"

declare global {
  namespace Express {
    interface Request {
      user?: TokenPayload
    }
  }
}

export const authMiddleware = (req: Request, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization
    const token = authHeader?.split(" ")[1]

    if (!token) {
      throw new ApiError(401, "Access token is missing")
    }

    const decoded = verifyAccessToken(token)
    req.user = decoded
    next()
  } catch (error) {
    next(new ApiError(401, "Invalid or expired access token"))
  }
}
