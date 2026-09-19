export type OtpPurpose = "verify_email" | "reset_password"

export interface OtpEmailParams {
  name?: string
  otp: string
  expiresInMinutes: number
  purpose: OtpPurpose
}

const OTP_COPY: Record<OtpPurpose, { title: string; heading: string; intro: string; ignore: string }> = {
  verify_email: {
    title: "Mã xác thực FlintFlow",
    heading: "Xác thực tài khoản",
    intro: "Cảm ơn bạn đã đăng ký FlintFlow. Nhập mã dưới đây để hoàn tất xác thực tài khoản:",
    ignore: "Nếu bạn không đăng ký tài khoản FlintFlow, hãy bỏ qua email này."
  },
  reset_password: {
    title: "Mã đặt lại mật khẩu FlintFlow",
    heading: "Đặt lại mật khẩu",
    intro: "Chúng tôi nhận được yêu cầu đặt lại mật khẩu cho tài khoản FlintFlow của bạn. Nhập mã dưới đây để tiếp tục:",
    ignore: "Nếu bạn không yêu cầu đặt lại mật khẩu, hãy bỏ qua email này — mật khẩu của bạn không thay đổi."
  }
}

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string)

// Màu lấy từ giao diện app (tím chủ đạo #4F46E5, nền nhạt #F4F3FE).
const BRAND = "#4F46E5"
const BRAND_SOFT = "#F4F3FE"
const TEXT = "#191817"
const MUTED = "#6B6862"
const BORDER = "#E4E1DC"
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"

/**
 * Email OTP: gọn, có nhận diện thương hiệu nhẹ, nhưng giữ các điều kiện để vào Hộp thư chính —
 * không ảnh, không link, không nút, chữ là chính, có bản text thuần đi kèm (`getOtpEmailText`).
 * Style inline (Gmail bỏ `<style>` trong một số trường hợp); bảng chỉ dùng để căn giữa, đúng chuẩn email.
 */
export const getOtpEmailHtml = ({ name, otp, expiresInMinutes, purpose }: OtpEmailParams): string => {
  const copy = OTP_COPY[purpose]
  const greeting = name ? `Xin chào ${escapeHtml(name)},` : "Xin chào,"
  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${copy.title}</title>
</head>
<body style="margin:0;padding:0;background-color:#ffffff;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr>
      <td align="center" style="padding:24px 16px;">
        <div style="max-width:480px;margin:0 auto;text-align:left;font-family:${FONT};color:${TEXT};border:1px solid ${BORDER};border-radius:14px;padding:32px 28px;">
          <div style="font-size:18px;font-weight:800;color:${BRAND};letter-spacing:-0.3px;">FlintFlow</div>

          <h1 style="margin:24px 0 8px;font-size:20px;font-weight:700;color:${TEXT};">${copy.heading}</h1>
          <p style="margin:0 0 6px;font-size:14px;line-height:1.6;color:${TEXT};">${greeting}</p>
          <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:${TEXT};">${copy.intro}</p>

          <div style="background-color:${BRAND_SOFT};border-radius:12px;padding:18px 12px;text-align:center;">
            <span style="font-family:'SFMono-Regular',Consolas,'Courier New',monospace;font-size:32px;font-weight:700;letter-spacing:10px;color:${BRAND};">${otp}</span>
          </div>

          <p style="margin:16px 0 0;font-size:13px;line-height:1.6;color:${MUTED};">
            Mã có hiệu lực trong <strong style="color:${TEXT};">${expiresInMinutes} phút</strong>.
            Vui lòng không chia sẻ mã này với bất kỳ ai, kể cả nhân viên FlintFlow.
          </p>
          <p style="margin:12px 0 0;font-size:13px;line-height:1.6;color:${MUTED};">${copy.ignore}</p>
        </div>
      </td>
    </tr>
  </table>
</body>
</html>`
}

export const getOtpEmailText = ({ name, otp, expiresInMinutes, purpose }: OtpEmailParams): string =>
  [
    "FlintFlow",
    "",
    name ? `Xin chào ${name},` : "Xin chào,",
    "",
    OTP_COPY[purpose].intro,
    "",
    `    ${otp}`,
    "",
    `Mã có hiệu lực trong ${expiresInMinutes} phút. Vui lòng không chia sẻ mã này với bất kỳ ai, kể cả nhân viên FlintFlow.`,
    OTP_COPY[purpose].ignore,
    "",
  ].join("\n")
