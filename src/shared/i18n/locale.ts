/**
 * Ngôn ngữ giao diện của tài khoản (FLF-259). Đứng riêng, không kéo theo Mongoose: nhiều unit test mock
 * `user.model.js` chỉ với `User`, nên hằng số đặt trong model sẽ làm vỡ các test đó khi module khác import.
 */
export const USER_LOCALES = ["vi", "en"] as const

export type UserLocale = (typeof USER_LOCALES)[number]

export const isUserLocale = (value: unknown): value is UserLocale => USER_LOCALES.includes(value as UserLocale)

/** Giá trị đọc từ tài khoản ⇒ locale hợp lệ; thiếu hoặc giá trị lạ ⇒ `null` (tài khoản chưa chọn). */
export const toUserLocale = (value: unknown): UserLocale | null => (isUserLocale(value) ? value : null)
