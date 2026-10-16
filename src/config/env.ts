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

  // ─── Embedding cho C-3 tìm vị trí CR theo nghĩa (`shared/ai/embedding/`) ───────────
  // `off` (mặc định) ⇒ C-3 tìm theo từ khoá như cũ, không gọi mạng. `gemini` cần GEMINI_API_KEY + Atlas Vector Search
  // (index `spine_embeddings_vector`, tạo bằng `npm run migrate:spine-embeddings`). `mock` = vector băm tất định (test).
  // AI_PROVIDER_OVERRIDE=mock ép `mock` trừ khi đang `off`.
  EMBEDDING_PROVIDER: z.enum(["off", "gemini", "mock"]).default("off"),
  EMBEDDING_MODEL: z.string().default("gemini-embedding-001"),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(768),
  EMBEDDING_API_BASE_URL: z.string().default("https://generativelanguage.googleapis.com/v1beta"),
  EMBEDDING_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
  /** Số ứng viên vector tối đa C-3 lấy thêm, và điểm tối thiểu (`vectorSearchScore` cosine của Atlas, 0..1). */
  CR_VECTOR_TOP_K: z.coerce.number().int().min(1).max(200).default(20),
  CR_VECTOR_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.82),

  // ─── Knowledge RAG (FLF-267, `modules/knowledge/`, docs/ops.md "Knowledge RAG") ───────────
  // Tắt ⇒ chat gửi `knowledge: true` nhận 409 KNOWLEDGE_DISABLED. Cần embedding (EMBEDDING_PROVIDER) + đã ingest corpus;
  // thiếu embedding thì chỉ tìm theo từ khoá ($text).
  KNOWLEDGE_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  /** Số chunk đưa vào prompt trả lời. */
  KNOWLEDGE_TOP_K: z.coerce.number().int().min(1).max(20).default(5),
  /** Ngưỡng cosine của chunk gần nhất; thấp hơn ⇒ "không đủ căn cứ", không gọi model. Hiệu chỉnh bằng `npm run eval:knowledge`. */
  KNOWLEDGE_MIN_SCORE: z.coerce.number().min(-1).max(1).default(0.66),
  /** Trọng số danh sách từ khoá trong RRF (1 = RRF chuẩn, 0 = chỉ xếp theo vector). Chọn bằng `eval:knowledge --retrieval-only`. */
  KNOWLEDGE_LEXICAL_WEIGHT: z.coerce.number().min(0).max(1).default(0),
  /** Thư mục corpus mặc định của `npm run ingest:knowledge` (tương đối thư mục chạy). */
  KNOWLEDGE_CORPUS_DIR: z.string().default("assets/skills"),
  /** `atlas` = `$vectorSearch` (Mongo không hỗ trợ ⇒ tự lùi về `memory`); `memory` = cosine vét cạn trong process. */
  KNOWLEDGE_VECTOR_BACKEND: z.enum(["atlas", "memory"]).default("atlas"),

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
  // Chờ (ms) trước mỗi lần thử lại khi không kết nối được PlantUML, phân cách bằng dấu phẩy; rỗng ⇒ không thử lại
  // (test tích hợp: PlantUML cố ý ở cổng đóng, mỗi lần thử lại làm một lượt vẽ chậm thêm vài giây)
  PLANTUML_RETRY_DELAYS_MS: z
    .string()
    .default("500,1500")
    .transform((value) => value.split(",").map((part) => part.trim()).filter(Boolean).map(Number))
    .pipe(z.array(z.number().int().nonnegative()).max(5)),

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
  // ─── Job nền (`shared/queue/`, docs/background-jobs.md) ───────────
  // `inline` (mặc định) ⇒ job chạy trong chính tiến trình API như trước, không cần Redis (dev, test, CI).
  // `bullmq` ⇒ job đi qua Redis; tiến trình `npm run worker` (hoặc WORKERS_IN_PROCESS=true) xử lý.
  JOB_DRIVER: z.enum(["inline", "bullmq"]).default("inline"),
  REDIS_URL: z.string().default(""),
  /**
   * Tiền tố key Redis. Hai môi trường dùng CHUNG một Redis (máy dev + production cùng Redis Cloud) phải khác tiền tố —
   * nếu không worker trên máy dev nhận job của production rồi chạy với Mongo của máy dev.
   */
  QUEUE_PREFIX: z.string().regex(/^[\w-]+$/).default("flintflow"),
  /** Chạy worker ngay trong tiến trình API (dev một terminal). Production: để `false` và chạy service `worker` riêng. */
  WORKERS_IN_PROCESS: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  /** Số job import (I-4 / finalize, mỗi job vài phút gọi AI) một worker chạy song song. */
  JOB_IMPORT_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(2),

  // Reservation credit quá TTL sẽ bị cron dọn (expireStaleReservations).
  CREDIT_RESERVE_TTL_MS: z.coerce.number().int().positive().default(10 * 60 * 1000),
  /** Hạn của mã mời vào tổ chức (UC-08). */
  INVITE_TTL_DAYS: z.coerce.number().int().positive().default(7),
  /** Độ dài mã mời. Mã để người dùng GÕ TAY nên giữ ngắn; bảng chữ 31 ký tự ⇒ 10 ký tự ≈ 49 bit. */
  INVITE_CODE_LENGTH: z.coerce.number().int().min(8).max(24).default(10),

  /**
   * Số ngày giữ prompt/response của lượt gọi model (`aiactionpayloads`). Prompt mang nguyên văn điều người
   * dùng nhập nên có hạn; `0` = không lưu gì. Số liệu token/chi phí trong `aiactionlogs` không bị hạn này.
   */
  AI_PAYLOAD_RETENTION_DAYS: z.coerce.number().int().min(0).max(365).default(30),
  /** Trần ký tự cho mỗi bên prompt/response trước khi cắt giữa; độ dài thật vẫn được ghi lại. */
  AI_PAYLOAD_MAX_CHARS: z.coerce.number().int().positive().default(40000)
}).refine((v) => v.JOB_DRIVER !== "bullmq" || v.REDIS_URL !== "", {
  message: "JOB_DRIVER=bullmq cần REDIS_URL (vd. redis://localhost:6379)",
  path: ["REDIS_URL"]
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
