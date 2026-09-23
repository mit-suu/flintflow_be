import { describe, expect, it } from "vitest"
import { loginSchema, registerSchema, resetPasswordSchema } from "./auth.validation.js"

const firstMessage = (result: { success: boolean; error?: { issues: { message: string }[] } }) =>
  result.success ? "" : (result.error?.issues[0]?.message ?? "")

describe("auth.validation — chuẩn mật khẩu mới", () => {
  it("đăng ký: mật khẩu yếu bị từ chối", () => {
    expect(firstMessage(registerSchema.safeParse({ email: "ai@fpt.vn", password: "matkhau2026" }))).toContain(
      "3 trong 4 nhóm"
    )
    expect(firstMessage(registerSchema.safeParse({ email: "ai@fpt.vn", password: "123456" }))).toContain(
      "ít nhất 8 ký tự"
    )
  })

  it("đăng ký: qua hết luật cứng nhưng mới mức 'Trung bình' vẫn bị từ chối", () => {
    expect(firstMessage(registerSchema.safeParse({ email: "ai@fpt.vn", password: "muaroi2!" }))).toContain(
      "chưa đủ mạnh"
    )
  })

  it("đăng ký: tiếng Việt có dấu bị từ chối", () => {
    expect(firstMessage(registerSchema.safeParse({ email: "ai@fpt.vn", password: "Đườngxưa1!" }))).toContain(
      "không dấu"
    )
  })

  it("đăng ký: từ mức 'Khá' trở lên thì qua", () => {
    expect(registerSchema.safeParse({ email: "ai@fpt.vn", password: "Mua2Roi!" }).success).toBe(true)
    expect(registerSchema.safeParse({ email: "ai@fpt.vn", password: "muaroi2026!x" }).success).toBe(true)
  })

  it("đăng ký: KHÔNG còn đối chiếu mật khẩu với email / tên", () => {
    expect(registerSchema.safeParse({ email: "minhhoang@fpt.vn", password: "Minhhoang2026" }).success).toBe(true)
  })

  it("đặt lại mật khẩu: áp cùng chuẩn với đăng ký", () => {
    expect(resetPasswordSchema.safeParse({ resetToken: "t", password: "123456" }).success).toBe(false)
    expect(resetPasswordSchema.safeParse({ resetToken: "t", password: "Mua2Roi!" }).success).toBe(true)
  })

  it("ĐĂNG NHẬP cố tình KHÔNG siết: tài khoản cũ dùng mật khẩu yếu vẫn phải vào được", () => {
    expect(loginSchema.safeParse({ email: "cu@fpt.vn", password: "abc123" }).success).toBe(true)
    // Chỉ chặn ô để trống
    expect(loginSchema.safeParse({ email: "cu@fpt.vn", password: "" }).success).toBe(false)
  })
})
