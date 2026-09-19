import { describe, it, expect } from "vitest"
import { getResetPasswordEmail, getVerificationEmail } from "./templates.js"

const URL = "https://app.flintflow.io/verify-email?token=abc"

describe("email templates (T25)", () => {
  it("mặc định tiếng Việt — giữ nguyên chữ cũ", () => {
    const { subject, html } = getVerificationEmail({ name: "Hiệp", url: URL })
    expect(subject).toBe("FlintFlow — Xác thực địa chỉ email của bạn")
    expect(html).toContain('<html lang="vi">')
    expect(html).toContain("Xin chào <strong>Hiệp</strong>,")
    expect(html).toContain("Xác thực tài khoản ngay")
    expect(html).toContain(URL)
  })

  it("en: tiêu đề, nội dung, lang và chân email đều tiếng Anh", () => {
    const { subject, html } = getVerificationEmail({ name: "Alex", url: URL, locale: "en" })
    expect(subject).toBe("FlintFlow — Verify your email address")
    expect(html).toContain('<html lang="en">')
    expect(html).toContain("Hi <strong>Alex</strong>,")
    expect(html).toContain("Verify my account")
    expect(html).toContain("If you didn't make this request")
    expect(html).not.toMatch(/Xin chào|Xác thực|vui lòng/i)
  })

  it("email đặt lại mật khẩu theo ngôn ngữ", () => {
    expect(getResetPasswordEmail({ url: URL }).subject).toBe("FlintFlow — Đặt lại mật khẩu tài khoản")
    const en = getResetPasswordEmail({ url: URL, locale: "en" })
    expect(en.subject).toBe("FlintFlow — Reset your password")
    expect(en.html).toContain("Hi,")
    expect(en.html).toContain("15 minutes")
  })

  it("tên do user đặt được escape — không chèn được HTML vào email", () => {
    const { html } = getVerificationEmail({ name: '<img src=x onerror="alert(1)">', url: URL })
    expect(html).not.toContain("<img src=x")
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;")
  })
})
