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
  // Cookie auth (FLF-137, `shared/auth/auth-cookie.ts`). FE và BE khác site ⇒ `none`;
  // cùng site (BE ở subdomain) ⇒ giữ `lax` và đặt COOKIE_DOMAIN=.flintflow.io.vn
  COOKIE_SAME_SITE: z.enum(["lax", "strict", "none"]).default("lax"),
  COOKIE_DOMAIN: z.string().default(""),

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

  // Không có default: một URL endpoint cá nhân nằm trong code nghĩa là quên cấu hình cũng không báo
  // lỗi, chỉ lặng lẽ gọi sang máy của người khác (T24). Thiếu ⇒ `AI_PROVIDER_NOT_CONFIGURED` ngay ở
  // lượt gọi đầu (`shared/ai/providers/modal.config.ts`).
  MODAL_BASE_URL: z.string().default(""),
  MODAL_PROXY_TOKEN_ID: z.string().default(""),
  MODAL_PROXY_TOKEN_SECRET: z.string().default(""),
  MODAL_API_KEY: z.string().default(""),

  // Ghi đè provider cho MỌI lượt gọi, bỏ qua frontmatter của skill. Chỉ dùng cho CI / smoke test —
  // để trống ở mọi môi trường thật. `mock` không gọi mạng và trả output hợp schema theo ActionType.
  AI_PROVIDER_OVERRIDE: z.string().default(""),

  // S-9.2 Quality Lens bằng LLM — mặc định TẮT (Phases §9.1, hoãn vì ngân sách).
  REVIEW_LLM_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1"),

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
  CREDIT_RESERVE_TTL_MS: z.coerce.number().int().positive().default(10 * 60 * 1000),
  /** Hạn của mã mời vào tổ chức (UC-08). */
  INVITE_TTL_DAYS: z.coerce.number().int().positive().default(7),
  /** Độ dài mã mời. Mã để người dùng GÕ TAY nên giữ ngắn; bảng chữ 31 ký tự ⇒ 10 ký tự ≈ 49 bit. */
  INVITE_CODE_LENGTH: z.coerce.number().int().min(8).max(24).default(10)
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
