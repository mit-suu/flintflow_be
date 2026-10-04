import { Request, Response, NextFunction } from "express"
import { ApiError } from "../utils/api-error.js"
import { verifyAccessToken } from "./jwt.util.js"

export const authMiddleware = (req: Request, _res: Response, next: NextFunction): void => {
  try {
    const authHeader = req.headers.authorization
    const token =
      authHeader?.split(" ")[1] ||
      req.cookies?.accessToken ||
      req.cookies?.token

    if (!token) {
      throw new ApiError(401, "Bạn chưa đăng nhập hoặc phiên đăng nhập đã hết hạn.", "MISSING_ACCESS_TOKEN")
    }

    const decoded = verifyAccessToken(token)
    req.user = decoded
    next()
  } catch (error) {
    if (error instanceof ApiError) {
      next(error)
    } else {
      next(new ApiError(401, "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.", "INVALID_ACCESS_TOKEN"))
    }
  }
}
