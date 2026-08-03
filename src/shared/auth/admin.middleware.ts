import { Request, Response, NextFunction } from "express"
import { ApiError } from "../utils/api-error.js"
import { User } from "../../modules/user/user.model.js"

export const adminMiddleware = async (
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userPayload = req.user as any

    if (!userPayload) {
      throw new ApiError(401, "Chưa xác thực người dùng", "UNAUTHORIZED")
    }

    const userId = userPayload.id || userPayload.userId
    let role = userPayload.role

    if (!role && userId) {
      const userDoc = await User.findById(userId)
      role = userDoc?.role
    }

    if (role !== "admin") {
      throw new ApiError(403, "Chỉ Admin mới có quyền thực hiện thao tác này", "FORBIDDEN")
    }

    next()
  } catch (error) {
    next(error)
  }
}
