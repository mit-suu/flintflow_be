/**
 * Chuẩn mật khẩu mới — nguồn sự thật cho MỌI chỗ đặt mật khẩu mới
 * (đăng ký, đặt lại qua OTP, đổi mật khẩu trong hồ sơ).
 *
 * Đây là **cổng chặn**: không đạt thì BE trả 400, FE khoá nút. Ngưỡng đạt là mức "Khá" trở lên —
 * xem `PASSWORD_MIN_LEVEL`.
 *
 * KHÔNG áp cho đăng nhập: tài khoản cũ có thể đang dùng mật khẩu yếu hơn chuẩn mới, siết ở login là
 * khoá họ ra khỏi tài khoản của chính mình. Họ chỉ phải theo chuẩn mới khi đặt lại mật khẩu.
 *
 * FE có bản sao ở `flintflow_fe/lib/password-policy.ts` để báo tại chỗ và vẽ thanh độ mạnh —
 * **sửa file này thì sửa cả bên đó**. BE vẫn là nơi quyết định.
 */

export const PASSWORD_MIN_LENGTH = 8

/**
 * bcrypt chỉ băm 72 byte đầu, phần dư bị bỏ im lặng — chặn thẳng cho người dùng biết, đừng để họ tưởng
 * mình đang có mật khẩu 100 ký tự. Mật khẩu chỉ nhận ASCII nên 1 ký tự = 1 byte.
 */
export const PASSWORD_MAX_LENGTH = 72

/** Số nhóm ký tự tối thiểu trong 4 nhóm: chữ thường · chữ HOA · chữ số · ký tự đặc biệt. */
export const PASSWORD_MIN_CHAR_CLASSES = 3

/** Độ dài để được coi là "dài" khi chấm mức — mốc 12 theo NIST SP 800-63B. */
const PASSWORD_LONG_LENGTH = 12

export type PasswordIssue =
  | "too_short"
  | "too_long"
  | "not_ascii"
  | "not_complex"
  | "not_strong_enough"

export const PASSWORD_ISSUE_MESSAGES: Record<PasswordIssue, string> = {
  too_short: `Mật khẩu phải có ít nhất ${PASSWORD_MIN_LENGTH} ký tự.`,
  too_long: `Mật khẩu tối đa ${PASSWORD_MAX_LENGTH} ký tự.`,
  not_ascii:
    "Mật khẩu chỉ dùng chữ không dấu, chữ số và ký tự đặc biệt trên bàn phím — không dùng tiếng Việt có dấu hay khoảng trắng.",
  not_complex: "Mật khẩu phải có ít nhất 3 trong 4 nhóm: chữ thường, chữ HOA, chữ số, ký tự đặc biệt.",
  not_strong_enough: `Mật khẩu chưa đủ mạnh — cần từ ${PASSWORD_LONG_LENGTH} ký tự, hoặc có đủ cả 4 nhóm ký tự.`
}

/** ASCII in được, KHÔNG gồm khoảng trắng (0x21–0x7E). Chặn cả chữ có dấu lẫn emoji. */
const ASCII_ONLY = /^[\x21-\x7E]+$/

const countCharClasses = (password: string): number =>
  [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) => re.test(password)).length

/** 0 = yếu · 1 = trung bình · 2 = khá · 3 = mạnh. Đạt chuẩn từ `PASSWORD_MIN_LEVEL`. */
export type PasswordLevel = 0 | 1 | 2 | 3

export const PASSWORD_MIN_LEVEL: PasswordLevel = 2

export const PASSWORD_LEVEL_LABELS: Record<PasswordLevel, string> = {
  0: "Yếu",
  1: "Trung bình",
  2: "Khá",
  3: "Mạnh"
}

/**
 * Vi phạm luật cứng ĐẦU TIÊN, hoặc `null` nếu mật khẩu qua hết. Trả một lỗi chứ không phải cả danh sách:
 * người dùng sửa từng cái một, dội 4 dòng đỏ cùng lúc chỉ làm họ bỏ cuộc.
 *
 * Không xét "đủ mạnh chưa" — đó là việc của `passwordLevel` / `checkPassword`.
 */
const basicIssue = (password: string): PasswordIssue | null => {
  if (password.length < PASSWORD_MIN_LENGTH) return "too_short"
  if (password.length > PASSWORD_MAX_LENGTH) return "too_long"
  if (!ASCII_ONLY.test(password)) return "not_ascii"
  if (countCharClasses(password) < PASSWORD_MIN_CHAR_CLASSES) return "not_complex"
  return null
}

/**
 * Mức độ mạnh để vẽ thanh đo. Qua hết luật cứng rồi mới chấm thêm theo độ dài và số nhóm ký tự,
 * vì với cùng bộ quy tắc, dài thêm một ký tự đáng giá hơn nhiều so với thêm một dấu chấm than.
 */
export const passwordLevel = (password: string): PasswordLevel => {
  if (basicIssue(password)) return 0

  const long = password.length >= PASSWORD_LONG_LENGTH
  const allClasses = countCharClasses(password) === 4
  if (long && allClasses) return 3
  if (long || allClasses) return 2
  return 1
}

/** Lý do mật khẩu bị từ chối, hoặc `null` nếu đạt chuẩn và được phép dùng. */
export const checkPassword = (password: string): PasswordIssue | null => {
  const issue = basicIssue(password)
  if (issue) return issue
  return passwordLevel(password) < PASSWORD_MIN_LEVEL ? "not_strong_enough" : null
}

/** Thông điệp lỗi tiếng Việt, hoặc `null` nếu mật khẩu đạt. */
export const passwordError = (password: string): string | null => {
  const issue = checkPassword(password)
  return issue ? PASSWORD_ISSUE_MESSAGES[issue] : null
}
