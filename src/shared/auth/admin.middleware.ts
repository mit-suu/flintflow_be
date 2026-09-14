import { Request, Response, NextFunction } from "express"
import { ApiError } from "../utils/api-error.js"
import { User } from "../../modules/user/user.model.js"

/**
 * Quyền admin đọc từ DB mỗi request, không tin `role` trong JWT: admin bị hạ quyền
 * hoặc bị khoá không được giữ quyền tới khi access token hết hạn (review T06).
 */
export const adminMiddleware = async (
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userPayload = req.user as { id?: string; userId?: string } | undefined

    if (!userPayload) {
      throw new ApiError(401, "Chưa xác thực người dùng", "UNAUTHORIZED")
    }

    const userId = userPayload.id || userPayload.userId
    const userDoc = userId ? await User.findById(userId) : null

    if (!userDoc || userDoc.isActive === false) {
      throw new ApiError(403, "Tài khoản không tồn tại hoặc đã bị khoá", "FORBIDDEN")
    }

    if (userDoc.role !== "admin") {
      throw new ApiError(403, "Chỉ Admin mới có quyền thực hiện thao tác này", "FORBIDDEN")
    }

    next()
  } catch (error) {
    next(error)
  }
}
