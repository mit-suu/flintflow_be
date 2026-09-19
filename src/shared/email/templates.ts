import { DEFAULT_USER_LOCALE, type UserLocale } from "../../modules/user/user.model.js"

export interface EmailTemplateParams {
  name?: string
  url: string
  /** Ngôn ngữ của user (T25); mặc định tiếng Việt. */
  locale?: UserLocale
}

export interface EmailContent {
  subject: string
  html: string
}

/** Tên do user tự đặt — phải escape trước khi chèn vào HTML email. */
const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string)

const COPY = {
  vi: {
    greeting: (name?: string) => (name ? `Xin chào <strong>${escapeHtml(name)}</strong>,` : "Xin chào,"),
    footer:
      "Email này được gửi tự động từ hệ thống FlintFlow Specification Engine.<br>\n        Nếu bạn không thực hiện yêu cầu này, vui lòng bỏ qua email này.",
    verify: {
      subject: "FlintFlow — Xác thực địa chỉ email của bạn",
      title: "Xác thực tài khoản FlintFlow",
      intro:
        "Cảm ơn bạn đã đăng ký tài khoản tại <strong>FlintFlow Platform</strong>. Vui lòng nhấn vào nút bên dưới để xác thực địa chỉ email của bạn và hoàn tất đăng ký:",
      button: "Xác thực tài khoản ngay",
      expiry: "Link xác thực này sẽ hết hạn trong <strong>24 giờ</strong>.",
      fallback: "Nếu nút trên không hoạt động, bạn có thể sao chép và dán liên kết sau vào trình duyệt:"
    },
    reset: {
      subject: "FlintFlow — Đặt lại mật khẩu tài khoản",
      title: "Đặt lại mật khẩu FlintFlow",
      intro:
        "Hệ thống nhận được yêu cầu đặt lại mật khẩu cho tài khoản FlintFlow của bạn. Vui lòng nhấn vào nút bên dưới để tạo mật khẩu mới:",
      button: "Đặt lại mật khẩu",
      expiry: "Link này sẽ hết hạn trong <strong>15 phút</strong> để bảo mật tài khoản của bạn.",
      notYou: "Nếu bạn không gửi yêu cầu đặt lại mật khẩu, tài khoản của bạn vẫn an toàn và không có sự thay đổi nào."
    }
  },
  en: {
    greeting: (name?: string) => (name ? `Hi <strong>${escapeHtml(name)}</strong>,` : "Hi,"),
    footer:
      "This email was sent automatically by the FlintFlow Specification Engine.<br>\n        If you didn't make this request, you can safely ignore this email.",
    verify: {
      subject: "FlintFlow — Verify your email address",
      title: "Verify your FlintFlow account",
      intro:
        "Thanks for signing up for <strong>FlintFlow Platform</strong>. Click the button below to verify your email address and finish signing up:",
      button: "Verify my account",
      expiry: "This verification link expires in <strong>24 hours</strong>.",
      fallback: "If the button doesn't work, copy and paste this link into your browser:"
    },
    reset: {
      subject: "FlintFlow — Reset your password",
      title: "Reset your FlintFlow password",
      intro: "We received a request to reset the password for your FlintFlow account. Click the button below to create a new password:",
      button: "Reset password",
      expiry: "For your security, this link expires in <strong>15 minutes</strong>.",
      notYou: "If you didn't request a password reset, your account is still safe and nothing has changed."
    }
  }
} as const

const baseLayout = (locale: UserLocale, title: string, content: string) => `
<!DOCTYPE html>
<html lang="${locale}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      background-color: #090d16;
      color: #e2e8f0;
    }
    .container {
      max-width: 560px;
      margin: 40px auto;
      background-color: #0f172a;
      border: 1px solid #1e293b;
      border-radius: 16px;
      padding: 32px;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5);
    }
    .logo-container {
      text-align: center;
      margin-bottom: 28px;
    }
    .logo {
      display: inline-block;
      width: 48px;
      height: 48px;
      line-height: 48px;
      background: linear-gradient(135deg, #6366f1, #a855f7, #ec4899);
      border-radius: 12px;
      font-weight: 900;
      font-size: 20px;
      color: #ffffff;
      text-align: center;
      box-shadow: 0 4px 12px rgba(99, 102, 241, 0.3);
    }
    .brand-name {
      margin-top: 10px;
      font-size: 18px;
      font-weight: 800;
      color: #f8fafc;
      letter-spacing: -0.5px;
    }
    h1 {
      font-size: 22px;
      font-weight: 700;
      color: #ffffff;
      margin-top: 0;
      margin-bottom: 16px;
      text-align: center;
    }
    p {
      font-size: 15px;
      line-height: 1.6;
      color: #94a3b8;
      margin-bottom: 24px;
    }
    .button-container {
      text-align: center;
      margin: 32px 0;
    }
    .btn {
      display: inline-block;
      padding: 14px 32px;
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      color: #ffffff !important;
      text-decoration: none;
      font-weight: 600;
      font-size: 15px;
      border-radius: 12px;
      box-shadow: 0 4px 14px rgba(99, 102, 241, 0.4);
      transition: all 0.2s ease;
    }
    .link-box {
      background-color: #020617;
      border: 1px solid #1e293b;
      border-radius: 8px;
      padding: 12px;
      font-size: 12px;
      color: #6366f1;
      word-break: break-all;
      margin-top: 24px;
    }
    .footer {
      margin-top: 36px;
      padding-top: 20px;
      border-top: 1px solid #1e293b;
      text-align: center;
      font-size: 12px;
      color: #64748b;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo-container">
      <div class="logo">FF</div>
      <div class="brand-name">FlintFlow AI Platform</div>
    </div>
    ${content}
    <div class="footer">
      <p style="margin: 0; font-size: 12px; color: #64748b;">
        ${COPY[locale].footer}
      </p>
    </div>
  </div>
</body>
</html>
`

export const getVerificationEmail = ({ name, url, locale = DEFAULT_USER_LOCALE }: EmailTemplateParams): EmailContent => {
  const copy = COPY[locale]
  const content = `
    <h1>${copy.verify.title}</h1>
    <p>${copy.greeting(name)}</p>
    <p>${copy.verify.intro}</p>
    <div class="button-container">
      <a href="${url}" class="btn">${copy.verify.button}</a>
    </div>
    <p>${copy.verify.expiry}</p>
    <p>${copy.verify.fallback}</p>
    <div class="link-box">${url}</div>
  `
  return { subject: copy.verify.subject, html: baseLayout(locale, copy.verify.title, content) }
}

export const getResetPasswordEmail = ({ name, url, locale = DEFAULT_USER_LOCALE }: EmailTemplateParams): EmailContent => {
  const copy = COPY[locale]
  const content = `
    <h1>${copy.reset.title}</h1>
    <p>${copy.greeting(name)}</p>
    <p>${copy.reset.intro}</p>
    <div class="button-container">
      <a href="${url}" class="btn">${copy.reset.button}</a>
    </div>
    <p>${copy.reset.expiry}</p>
    <p>${copy.reset.notYou}</p>
    <div class="link-box">${url}</div>
  `
  return { subject: copy.reset.subject, html: baseLayout(locale, copy.reset.title, content) }
}
