import mongoose from "mongoose"
import { User } from "./user.model.js"
import { toUserLocale, type UserLocale } from "../../shared/i18n/locale.js"

/**
 * Ngôn ngữ giao diện tài khoản đã lưu (FLF-259) — ngôn ngữ trả lời khi phiên chat chưa có (FLF-260). Chưa nối DB
 * (unit test) hay đọc lỗi ⇒ `null`: đây là chuyện phụ, không được làm hỏng lượt chat.
 */
export const accountLocaleOf = async (userId: string | null | undefined): Promise<UserLocale | null> => {
  if (!userId || mongoose.connection.readyState !== 1) return null
  try {
    const user = await User.findById(userId, { locale: 1 }).lean()
    return toUserLocale(user?.locale)
  } catch (err) {
    console.warn("[accountLocaleOf] Không đọc được ngôn ngữ tài khoản:", err)
    return null
  }
}
