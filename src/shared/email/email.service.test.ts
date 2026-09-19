import { beforeEach, describe, expect, it, vi } from "vitest"

// env.ts đọc biến môi trường một lần lúc import ⇒ đặt trước khi import email.service
const { sendMail, createTransport } = vi.hoisted(() => {
  process.env.SMTP_HOST = "smtp.gmail.com"
  process.env.SMTP_PORT = "465"
  process.env.SMTP_USER = "sender@gmail.com"
  process.env.SMTP_PASS = "app-password-16ch"
  process.env.EMAIL_FROM = "FlintFlow <no-reply@flintflow.io.vn>"
  const sendMail = vi.fn()
  return { sendMail, createTransport: vi.fn(() => ({ sendMail })) }
})
vi.mock("nodemailer", () => ({ default: { createTransport } }))

import { sendPasswordResetOtpEmail, sendVerificationOtpEmail } from "./email.service.js"

const lastMail = () => sendMail.mock.calls[sendMail.mock.calls.length - 1][0]

describe("email OTP — dấu hiệu 'thư người gửi' để vào Hộp thư chính", () => {
  beforeEach(() => {
    sendMail.mockReset().mockResolvedValue({})
  })

  it("gửi qua Gmail bằng đúng tài khoản SMTP, EHLO và Message-ID mang domain người gửi (không phải tên máy)", async () => {
    await sendVerificationOtpEmail("user@example.com", "123456", "Hiệp")

    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({ name: "gmail.com" }))
    const mail = lastMail()
    expect(mail.from).toEqual({ name: "FlintFlow", address: "sender@gmail.com" })
    expect(mail.messageId).toMatch(/^<[0-9a-f-]{36}@gmail\.com>$/)
  })

  it("có Reply-To về người gửi và không có header của thư hàng loạt", async () => {
    await sendPasswordResetOtpEmail("user@example.com", "654321")

    const mail = lastMail()
    expect(mail.replyTo).toEqual({ name: "FlintFlow", address: "sender@gmail.com" })
    const headerNames = Object.keys(mail.headers ?? {}).map((h) => h.toLowerCase())
    for (const bulk of ["precedence", "auto-submitted", "list-unsubscribe", "x-entity-ref-id"]) {
      expect(headerNames).not.toContain(bulk)
    }
  })

  it("có bản chữ thuần; HTML không link/ảnh/nút (dấu hiệu thư quảng cáo), không 'vui lòng không trả lời'", async () => {
    await sendVerificationOtpEmail("user@example.com", "123456", "<b>Hiệp</b>")

    const { html, text, subject } = lastMail()
    expect(subject).toBe("123456 là mã xác thực FlintFlow của bạn")
    expect(text).toContain("123456")
    expect(html).toContain("123456")
    expect(html).not.toMatch(/<a\s|<img|<button|href=|src=|<style/i)
    expect(`${html}${text}`).not.toMatch(/không trả lời/i)
    // tên người dùng được escape trong HTML
    expect(html).toContain("&lt;b&gt;Hiệp&lt;/b&gt;")
  })

  it("tiêu đề trong thư theo mục đích: xác thực tài khoản / đặt lại mật khẩu", async () => {
    await sendVerificationOtpEmail("user@example.com", "111111")
    expect(lastMail().html).toContain("Xác thực tài khoản")

    await sendPasswordResetOtpEmail("user@example.com", "222222")
    const { html, subject } = lastMail()
    expect(html).toContain("Đặt lại mật khẩu")
    expect(subject).toBe("222222 là mã đặt lại mật khẩu FlintFlow của bạn")
  })
})
