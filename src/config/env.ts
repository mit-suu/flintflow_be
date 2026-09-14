/**
 * env.ts
 * ─────────────────────────────────────────────────────────────────
 * Đọc + VALIDATE biến môi trường một lần, fail-fast lúc khởi động.
 *
 * Vì sao validate: bản trước là một object hand-rolled với default hardcode,
 * nghĩa là thiếu secret cũng chạy — JWT_ACCESS_SECRET âm thầm thành
 * "access-secret". Một service ký token bằng secret ai cũng đoán được thì
 * không phải là service có auth.
 *
 * Nguyên tắc:
 *   - Mọi field giữ ĐÚNG kiểu như trước (chủ yếu string) để không phải sửa
 *     28 chỗ đang đọc `env.*`.
 *   - Ở production, những secret có default không an toàn trở thành BẮT BUỘC.
 *   - Ở development, default vẫn còn để `npm run dev` chạy được ngay.
 */

import dotenv from "dotenv"
import { fileURLToPath } from "url"
import path from "path"
import { z } from "zod"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.resolve(__dirname, "../../.env") })

const isProd = process.env.NODE_ENV === "production"

/** Secret không được dùng giá trị placeholder ở production. */
const INSECURE_DEFAULTS = new Set([
  "access-secret",
  "refresh-secret",
  "your_access_secret_here",
  "your_refresh_secret_here"
])

const secret = (devDefault: string) =>
  z
    .string()
    .default(devDefault)
    .refine((v) => !isProd || (v.length >= 32 && !INSECURE_DEFAULTS.has(v)), {
      message: "ở production phải được set tường minh và dài ≥ 32 ký tự"
    })

const envSchema = z.object({
  PORT: z.string().default("5000"),
  NODE_ENV: z.string().default("development"),

  MONGO_URI: z
    .string()
    .default("mongodb://localhost:27017/flintflow")
    .refine((v) => !isProd || !v.includes("localhost"), {
      message: "ở production không được trỏ localhost"
    }),

  CLIENT_URL: z.string().default("http://localhost:3000"),
  APP_URL: z.string().default("http://localhost:3000"),

  JWT_ACCESS_SECRET: secret("access-secret"),
  JWT_REFRESH_SECRET: secret("refresh-secret"),
  ACCESS_TOKEN_EXPIRES: z.string().default("15m"),
  REFRESH_TOKEN_EXPIRES: z.string().default("3d"),

  SMTP_HOST: z.string().default("smtp.gmail.com"),
  SMTP_PORT: z.string().default("465"),
  SMTP_USER: z.string().default(""),
  SMTP_PASS: z.string().default(""),
  EMAIL_FROM: z.string().default("FlintFlow <no-reply@flintflow.io.vn>"),

  GOOGLE_CLIENT_ID: z.string().default(""),

  CLOUDINARY_CLOUD_NAME: z.string().default(""),
  CLOUDINARY_API_KEY: z.string().default(""),
  CLOUDINARY_API_SECRET: z.string().default(""),

  ADMIN_EMAIL: z.string().optional(),
  ADMIN_PASSWORD: z.string().optional(),

  OPENAI_API_KEY: z.string().default(""),
  ANTHROPIC_API_KEY: z.string().default(""),
  GEMINI_API_KEY: z.string().default(""),

  MODAL_BASE_URL: z
    .string()
    .default(
      "https://trantuanhiep28122003--ep-mary-flintflow-analysis-server.us-west.modal.direct/v1"
    ),
  MODAL_PROXY_TOKEN_ID: z.string().default(""),
  MODAL_PROXY_TOKEN_SECRET: z.string().default(""),
  MODAL_API_KEY: z.string().default(""),

  // ─── PlantUML (render diagram phía server, Phases §7.1) ───────────
  // Self-host: `docker compose up -d plantuml`. Ở production PlantUML là một
  // service RIÊNG, không phải sidecar trong image này.
  PLANTUML_BASE_URL: z.string().default("http://localhost:8080"),
  PLANTUML_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),

  // ─── Billing: payment_service dùng chung (VietQR/SePay) ───────────
  // Để trống ⇒ checkout trả 503 PAYMENT_SERVICE_NOT_CONFIGURED.
  PAYMENT_SERVICE_URL: z.string().default(""),
  PAYMENT_CLIENT_ID: z.string().default(""),
  PAYMENT_API_KEY: z.string().default(""),
  PAYMENT_SERVICE_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  // Domain public của BE này: payment service POST về
  // <APP_PUBLIC_URL>/api/v1/billing/payment-callback. Production không được là localhost.
  APP_PUBLIC_URL: z
    .string()
    .default("http://localhost:5000")
    .refine((v) => !isProd || !v.includes("localhost"), {
      message: "ở production phải là domain public, không được trỏ localhost"
    }),
  // Reservation credit quá TTL sẽ bị cron dọn (expireStaleReservations).
  CREDIT_RESERVE_TTL_MS: z.coerce.number().int().positive().default(10 * 60 * 1000)
})

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
    .join("\n")
  console.error(`\n❌ Cấu hình môi trường không hợp lệ (NODE_ENV=${process.env.NODE_ENV}):\n${issues}\n`)
  process.exit(1)
}

export const env = parsed.data
