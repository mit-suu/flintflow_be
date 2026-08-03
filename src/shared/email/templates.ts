export interface EmailTemplateParams {
  name?: string
  url: string
}

const baseLayout = (title: string, content: string) => `
<!DOCTYPE html>
<html lang="vi">
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
        Email này được gửi tự động từ hệ thống FlintFlow Specification Engine.<br>
        Nếu bạn không thực hiện yêu cầu này, vui lòng bỏ qua email này.
      </p>
    </div>
  </div>
</body>
</html>
`

export const getVerificationEmailHtml = ({ name, url }: EmailTemplateParams): string => {
  const greeting = name ? `Xin chào <strong>${name}</strong>,` : "Xin chào,"
  const content = `
    <h1>Xác thực tài khoản FlintFlow</h1>
    <p>${greeting}</p>
    <p>Cảm ơn bạn đã đăng ký tài khoản tại <strong>FlintFlow Platform</strong>. Vui lòng nhấn vào nút bên dưới để xác thực địa chỉ email của bạn và hoàn tất đăng ký:</p>
    <div class="button-container">
      <a href="${url}" class="btn">Xác thực tài khoản ngay</a>
    </div>
    <p>Link xác thực này sẽ hết hạn trong <strong>24 giờ</strong>.</p>
    <p>Nếu nút trên không hoạt động, bạn có thể sao chép và dán liên kết sau vào trình duyệt:</p>
    <div class="link-box">${url}</div>
  `
  return baseLayout("Xác thực tài khoản FlintFlow", content)
}

export const getResetPasswordEmailHtml = ({ name, url }: EmailTemplateParams): string => {
  const greeting = name ? `Xin chào <strong>${name}</strong>,` : "Xin chào,"
  const content = `
    <h1>Đặt lại mật khẩu FlintFlow</h1>
    <p>${greeting}</p>
    <p>Hệ thống nhận được yêu cầu đặt lại mật khẩu cho tài khoản FlintFlow của bạn. Vui lòng nhấn vào nút bên dưới để tạo mật khẩu mới:</p>
    <div class="button-container">
      <a href="${url}" class="btn">Đặt lại mật khẩu</a>
    </div>
    <p>Link này sẽ hết hạn trong <strong>15 phút</strong> để bảo mật tài khoản của bạn.</p>
    <p>Nếu bạn không gửi yêu cầu đặt lại mật khẩu, tài khoản của bạn vẫn an toàn và không có sự thay đổi nào.</p>
    <div class="link-box">${url}</div>
  `
  return baseLayout("Đặt lại mật khẩu FlintFlow", content)
}
