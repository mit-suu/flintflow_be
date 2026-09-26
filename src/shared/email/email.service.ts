import crypto from "crypto"
import nodemailer from "nodemailer"
import { env } from "../../config/env.js"
import { getOtpEmailHtml, getOtpEmailText, type OtpPurpose, getInvitationEmailHtml, getInvitationEmailText } from "./templates.js"

let transporter: nodemailer.Transporter | null = null

const getTransporter = (): nodemailer.Transporter | null => {
  if (transporter) return transporter

  if (env.SMTP_USER && env.SMTP_PASS) {
    const port = parseInt(env.SMTP_PORT, 10) || 465
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST || "smtp.gmail.com",
      port,
      secure: port === 465, // true for 465, false for other ports
      // Tên chào (EHLO) mặc định là tên máy (vd. `DESKTOP-AB12`) — lệch domain người gửi, bộ lọc Spam
      // coi là dấu hiệu gửi từ máy lạ. Dùng domain của địa chỉ gửi.
      name: senderDomain(getSender().address),
      auth: {
        user: env.SMTP_USER,
        pass: env.SMTP_PASS
      }
    })
    return transporter
  }

  return null
}

const senderDomain = (address: string): string => address.split("@")[1]?.toLowerCase() || "localhost"

const isGmailSmtp = (): boolean => /(^|\.)gmail\.com$/i.test(env.SMTP_HOST || "smtp.gmail.com")

/**
 * Người gửi. EMAIL_FROM có dạng `Tên <địa-chỉ>`. Với Gmail SMTP, địa chỉ gửi phải trùng tài khoản
 * đăng nhập (SMTP_USER): khác đi thì SPF/DKIM không khớp domain From và thư dễ rơi vào Spam.
 */
export const getSender = (): { name: string; address: string } => {
  const raw = env.EMAIL_FROM.trim()
  const bracket = raw.match(/^"?([^"<]*?)"?\s*<([^>]+)>$/)
  const bareAddress = raw.match(/[^\s<>"]+@[^\s<>"]+/)?.[0]
  const name = (bracket ? bracket[1] : raw.replace(bareAddress ?? "", "")).trim() || "FlintFlow"
  const configured = bracket?.[2].trim() ?? bareAddress ?? env.SMTP_USER
  const address = isGmailSmtp() && env.SMTP_USER.includes("@") ? env.SMTP_USER : configured
  return { name, address }
}

/**
 * Header để thư trông như thư người gửi (Hộp thư chính) thay vì thư hàng loạt (Cập nhật/Quảng cáo/Spam):
 * - `Message-ID` mang domain người gửi — mặc định nodemailer lấy tên máy;
 * - `Reply-To` về chính người gửi — thư "không trả lời được" là dấu hiệu thư tự động.
 * Cố ý KHÔNG thêm `Precedence: bulk`, `Auto-Submitted`, `List-Unsubscribe` (dấu hiệu thư hàng loạt).
 */
export const buildPersonalHeaders = (sender: { name: string; address: string }) => ({
  messageId: `<${crypto.randomUUID()}@${senderDomain(sender.address)}>`,
  replyTo: sender
})

const OTP_SUBJECT: Record<OtpPurpose, (otp: string) => string> = {
  verify_email: (otp) => `${otp} là mã xác thực FlintFlow của bạn`,
  reset_password: (otp) => `${otp} là mã đặt lại mật khẩu FlintFlow của bạn`
}

const sendOtpEmail = async (
  purpose: OtpPurpose,
  toEmail: string,
  otp: string,
  name?: string
): Promise<void> => {
  const params = { name, otp, expiresInMinutes: 2, purpose }
  const activeTransporter = getTransporter()

  if (activeTransporter) {
    try {
      const sender = getSender()
      await activeTransporter.sendMail({
        from: sender,
        to: toEmail,
        subject: OTP_SUBJECT[purpose](otp),
        text: getOtpEmailText(params),
        html: getOtpEmailHtml(params),
        ...buildPersonalHeaders(sender)
      })
      console.log(`[EMAIL SERVICE] ${purpose} OTP sent to ${toEmail}`)
      return
    } catch (error) {
      console.error(`[EMAIL SERVICE ERROR] Failed to send email via SMTP to ${toEmail}:`, error)
      // Fallback to console log so developer/user can proceed
    }
  }

  // Console Fallback if SMTP not configured or failed
  console.log("\n=======================================================")
  console.log(`[DEV EMAIL SIMULATION] ${purpose} OTP for ${toEmail}`)
  console.log(`OTP: ${otp}`)
  console.log("=======================================================\n")
}

export const sendVerificationOtpEmail = (toEmail: string, otp: string, name?: string): Promise<void> =>
  sendOtpEmail("verify_email", toEmail, otp, name)

export const sendPasswordResetOtpEmail = (toEmail: string, otp: string, name?: string): Promise<void> =>
  sendOtpEmail("reset_password", toEmail, otp, name)

export interface OrgInvitationEmailInput {
  name?: string
  code: string
  organizationName: string
  roleLabel: string
  inviterName: string
  expiresInDays: number
}

/**
 * UC-08 / BPMN Flow 9.2 — Email Service gửi mã mời cho người được mời.
 * Cùng đường đi và cùng cách dự phòng như email OTP: SMTP chưa cấu hình hoặc gửi lỗi thì in ra console
 * để dev vẫn lấy được mã mà chạy tiếp.
 */
export const sendOrgInvitationEmail = async (
  toEmail: string,
  input: OrgInvitationEmailInput
): Promise<void> => {
  const activeTransporter = getTransporter()

  if (activeTransporter) {
    try {
      const sender = getSender()
      await activeTransporter.sendMail({
        from: sender,
        to: toEmail,
        subject: `Lời mời tham gia ${input.organizationName} trên FlintFlow`,
        text: getInvitationEmailText(input),
        html: getInvitationEmailHtml(input),
        ...buildPersonalHeaders(sender)
      })
      console.log(`[EMAIL SERVICE] org invitation sent to ${toEmail}`)
      return
    } catch (error) {
      console.error(`[EMAIL SERVICE ERROR] Failed to send invitation to ${toEmail}:`, error)
    }
  }

  console.log("\n=======================================================")
  console.log(`[DEV EMAIL SIMULATION] org invitation for ${toEmail}`)
  console.log(`Organization: ${input.organizationName} · Role: ${input.roleLabel}`)
  console.log(`Code: ${input.code}`)
  console.log("=======================================================\n")
}
