import nodemailer from "nodemailer"
import { env } from "../../config/env.js"
import { getVerificationEmail, getResetPasswordEmail } from "./templates.js"
import type { UserLocale } from "../../modules/user/user.model.js"

let transporter: nodemailer.Transporter | null = null

const getTransporter = (): nodemailer.Transporter | null => {
  if (transporter) return transporter

  if (env.SMTP_USER && env.SMTP_PASS) {
    const port = parseInt(env.SMTP_PORT, 10) || 465
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST || "smtp.gmail.com",
      port,
      secure: port === 465, // true for 465, false for other ports
      auth: {
        user: env.SMTP_USER,
        pass: env.SMTP_PASS
      }
    })
    return transporter
  }

  return null
}

export const sendVerificationEmail = async (
  toEmail: string,
  rawToken: string,
  name?: string,
  locale?: UserLocale
): Promise<void> => {
  const verifyUrl = `${env.APP_URL}/verify-email?token=${rawToken}`
  const { subject, html } = getVerificationEmail({ name, url: verifyUrl, locale })
  const activeTransporter = getTransporter()

  if (activeTransporter) {
    try {
      await activeTransporter.sendMail({
        from: env.EMAIL_FROM,
        to: toEmail,
        subject,
        html
      })
      console.log(`[EMAIL SERVICE] Verification email sent to ${toEmail}`)
      return
    } catch (error) {
      console.error(`[EMAIL SERVICE ERROR] Failed to send email via SMTP to ${toEmail}:`, error)
      // Fallback to console log so developer/user can proceed
    }
  }

  // Console Fallback if SMTP not configured or failed
  console.log("\n=======================================================")
  console.log(`[DEV EMAIL SIMULATION] Verification Email for ${toEmail}`)
  console.log(`VERIFY LINK: ${verifyUrl}`)
  console.log("=======================================================\n")
}

export const sendPasswordResetEmail = async (
  toEmail: string,
  rawToken: string,
  name?: string,
  locale?: UserLocale
): Promise<void> => {
  const resetUrl = `${env.APP_URL}/reset-password?token=${rawToken}`
  const { subject, html } = getResetPasswordEmail({ name, url: resetUrl, locale })
  const activeTransporter = getTransporter()

  if (activeTransporter) {
    try {
      await activeTransporter.sendMail({
        from: env.EMAIL_FROM,
        to: toEmail,
        subject,
        html
      })
      console.log(`[EMAIL SERVICE] Password reset email sent to ${toEmail}`)
      return
    } catch (error) {
      console.error(`[EMAIL SERVICE ERROR] Failed to send email via SMTP to ${toEmail}:`, error)
    }
  }

  // Console Fallback
  console.log("\n=======================================================")
  console.log(`[DEV EMAIL SIMULATION] Password Reset Email for ${toEmail}`)
  console.log(`RESET LINK: ${resetUrl}`)
  console.log("=======================================================\n")
}
