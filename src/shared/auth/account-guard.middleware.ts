import { Request, Response, NextFunction } from "express"
import { User } from "../../modules/user/user.model.js"
import { ApiError } from "../utils/api-error.js"

/**
 * BPMN Flow 10.4 — "Read the account from the database; the role carried in the token is never trusted",
 * rồi gateway "Account active?" → Suspended ⇒ 403 (UC-66).
 *
 * Đứng sau `authMiddleware` và TRƯỚC nhánh rẽ Administration (10.5) / Organization (10.6). Đọc DB mỗi
 * request, KHÔNG cache: tài khoản bị khoá phải mất quyền ngay từ request kế tiếp, không đợi access token
 * hết hạn.
 *
 * Vì sao là middleware riêng chứ không gộp vào `authMiddleware`: `authMiddleware` chạy trong cả những
 * test lớp route không nối Mongo; tách ra để chỗ nào cần chạm DB thì khai báo rõ.
 */
export const requireActiveAccount = async (
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.user?.userId
    if (!userId) {
      throw new ApiError(401, "Chưa xác thực người dùng", "UNAUTHORIZED")
    }

    const user = await User.findById(userId).select("_id email role isActive").lean()
    // Cùng mã 403 như `adminMiddleware`: token còn hạn nhưng tài khoản đã mất hiệu lực.
    if (!user) {
      throw new ApiError(403, "Tài khoản không còn tồn tại", "ACCOUNT_NOT_FOUND")
    }
    if (user.isActive === false) {
      throw new ApiError(403, "Tài khoản đã bị khoá", "ACCOUNT_SUSPENDED")
    }

    req.account = {
      userId: String(user._id),
      email: user.email,
      role: user.role,
      isActive: user.isActive
    }
    next()
  } catch (error) {
    next(error)
  }
}
