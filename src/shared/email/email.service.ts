import crypto from "crypto"
import nodemailer from "nodemailer"
import { env } from "../../config/env.js"
import { defineJob, enqueueJob } from "../queue/job-runner.js"
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

/** SMTP chưa cấu hình (dev, test, CI) hoặc gửi hết lượt vẫn lỗi ⇒ in ra console để dev vẫn lấy được mã mà chạy tiếp. */
const printSimulation = (title: string, lines: string[]): void => {
  console.log("\n=======================================================")
  console.log(`[DEV EMAIL SIMULATION] ${title}`)
  for (const line of lines) console.log(line)
  console.log("=======================================================\n")
}

/** Gửi thật. SMTP lỗi ⇒ NÉM để queue retry; SMTP chưa cấu hình ⇒ in console. */
export const deliverOtpEmail = async (purpose: OtpPurpose, toEmail: string, otp: string, name?: string): Promise<void> => {
  const activeTransporter = getTransporter()
  if (!activeTransporter) {
    printSimulation(`${purpose} OTP for ${toEmail}`, [`OTP: ${otp}`])
    return
  }
  const params = { name, otp, expiresInMinutes: 2, purpose }
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
}

interface OtpEmailJob {
  purpose: OtpPurpose
  toEmail: string
  otp: string
  name?: string
}

/**
 * OTP chỉ sống 2 phút ⇒ retry nhanh (5s, 10s) rồi thôi. Job mang OTP dạng rõ ⇒ xoá khỏi Redis ngay khi xong, job lỗi
 * giữ 10 phút (quá hạn OTP) — không log `data`.
 */
const otpEmailJob = defineJob<OtpEmailJob>({
  queue: "email",
  name: "otp",
  options: { attempts: 3, backoff: { type: "exponential", delay: 5_000 }, removeOnComplete: true, removeOnFail: { age: 600 } },
  // Driver inline: chờ gửi xong như trước khi có queue
  inlineAwait: true,
  process: (d) => deliverOtpEmail(d.purpose, d.toEmail, d.otp, d.name),
  onFinalFailure: async (d, error) => {
    console.error(`[EMAIL SERVICE ERROR] Failed to send email via SMTP to ${d.toEmail}:`, error)
    printSimulation(`${d.purpose} OTP for ${d.toEmail}`, [`OTP: ${d.otp}`])
  }
})

export const sendVerificationOtpEmail = (toEmail: string, otp: string, name?: string): Promise<void> =>
  enqueueJob(otpEmailJob, { purpose: "verify_email", toEmail, otp, ...(name ? { name } : {}) })

export const sendPasswordResetOtpEmail = (toEmail: string, otp: string, name?: string): Promise<void> =>
  enqueueJob(otpEmailJob, { purpose: "reset_password", toEmail, otp, ...(name ? { name } : {}) })

export interface OrgInvitationEmailInput {
  name?: string
  code: string
  organizationName: string
  roleLabel: string
  inviterName: string
  expiresInDays: number
}

/** UC-08 / BPMN Flow 9.2 — gửi thật mã mời. SMTP lỗi ⇒ ném để queue retry; chưa cấu hình ⇒ in console. */
export const deliverOrgInvitationEmail = async (toEmail: string, input: OrgInvitationEmailInput): Promise<void> => {
  const activeTransporter = getTransporter()
  if (!activeTransporter) {
    printInvitationSimulation(toEmail, input)
    return
  }
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
}

const printInvitationSimulation = (toEmail: string, input: OrgInvitationEmailInput): void =>
  printSimulation(`org invitation for ${toEmail}`, [`Organization: ${input.organizationName} · Role: ${input.roleLabel}`, `Code: ${input.code}`])

/** Mã mời sống nhiều ngày ⇒ retry thưa hơn OTP. */
const invitationEmailJob = defineJob<{ toEmail: string; input: OrgInvitationEmailInput }>({
  queue: "email",
  name: "invitation",
  options: { attempts: 5, backoff: { type: "exponential", delay: 30_000 }, removeOnComplete: true },
  process: (d) => deliverOrgInvitationEmail(d.toEmail, d.input),
  onFinalFailure: async (d, error) => {
    console.error(`[EMAIL SERVICE ERROR] Failed to send invitation to ${d.toEmail}:`, error)
    printInvitationSimulation(d.toEmail, d.input)
  }
})

/**
 * Đưa email mời vào hàng đợi (không chờ gửi). Hỏng SMTP không được làm hỏng việc tạo mã — Lead vẫn đọc được mã ở
 * response; queue tự gửi lại.
 */
export const sendOrgInvitationEmail = (toEmail: string, input: OrgInvitationEmailInput): Promise<void> =>
  enqueueJob(invitationEmailJob, { toEmail, input })
