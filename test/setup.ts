/**
 * setup.ts (T22)
 * ─────────────────────────────────────────────────────────────────
 * Chạy trước mỗi file test integration / e2e-ai:
 *   - trỏ `MONGO_URI` vào Mongo in-memory (database riêng theo worker) TRƯỚC khi file test import `app`
 *     — `app.ts` gọi `connectDB()` ngay lúc import và `env.ts` đọc biến một lần;
 *   - chờ kết nối, dựng index (unique `(projectId, seq)` của Change là thứ op engine dựa vào);
 *   - xoá dữ liệu trước mỗi test.
 * Helper dùng chung: `seedFixture(kind)`, `authAs(user)`, `resetDb()`.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, beforeEach, inject } from "vitest"
import mongoose from "mongoose"

const workerDb = `flintflow-test-${process.env.VITEST_POOL_ID ?? "0"}`
const withDbName = (uri: string, db: string): string => {
  const url = new URL(uri)
  url.pathname = `/${db}`
  return url.toString()
}

process.env.NODE_ENV = "test"
process.env.MONGO_URI = withDbName(inject("mongoUri"), workerDb)
// Không để lượt test gửi mail / gọi payment thật dù máy dev có .env
process.env.SMTP_USER = ""
process.env.SMTP_PASS = ""
process.env.PAYMENT_SERVICE_URL = ""
// payment-service.client bị mock trong billing.int.test.ts; callback so client_id với biến này
process.env.PAYMENT_CLIENT_ID = "flintflow-test-client"
// Không có PlantUML trong test: cổng đóng + timeout ngắn ⇒ render trả `render_status: "error"` ngay, tất định
// (máy dev đang chạy PlantUML ở :8080 cũng không làm kết quả đổi theo máy)
process.env.PLANTUML_BASE_URL = "http://127.0.0.1:9"
process.env.PLANTUML_TIMEOUT_MS = "1000"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const FIXTURES_DIR = path.resolve(__dirname, "../fixtures")

export const readFixtureJson = <T = unknown>(...segments: string[]): T =>
  JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, ...segments), "utf8")) as T

/** Xoá dữ liệu mọi collection, giữ index. */
export const resetDb = async (): Promise<void> => {
  const db = mongoose.connection.db
  if (!db) return
  const collections = await db.collections()
  await Promise.all(collections.map((c) => c.deleteMany({})))
}

beforeAll(async () => {
  if (mongoose.connection.readyState !== 1) {
    // `app.ts` có thể đã bắt đầu connect cùng URI — mongoose trả lại kết nối đang mở
    await mongoose.connect(process.env.MONGO_URI as string)
  }
  await mongoose.connection.asPromise()
  // Model được đăng ký khi file test import code; dựng index trước khi test chạy
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()))
})

beforeEach(async () => {
  await resetDb()
})

afterAll(async () => {
  await mongoose.disconnect()
})

// ─── Seed ───────────────────────────────────────────────────────────

export type FixtureKind = "full" | "minimal"

const FIXTURE_FILES: Record<FixtureKind, string> = {
  full: "spine-fixture-19-screens.json",
  minimal: "spine-fixture-minimal.json"
}

export interface SeedOptions {
  /** Số dư ví credit ban đầu (mặc định 1000 — đủ cho mọi luồng mock). `null` ⇒ không tạo ví (ví tự tạo lần đầu dùng). */
  balance?: number | null
  email?: string
  /** Sửa Spine trước khi ghi (vd đặt `steps`, `progress`). */
  mutate?: (spine: Record<string, unknown>) => void
  /** Không tạo Spine (test lazy-create ở GET /spine). */
  withoutSpine?: boolean
}

export interface SeededFixture {
  user: { _id: mongoose.Types.ObjectId; email: string; role?: string }
  userId: string
  /** Org của fixture — user là Lead, project và ví thuộc về org này. */
  orgId: string
  projectId: string
  sessionId: string
  spineVersion: number
  token: string
}

export interface AuthUser {
  _id: mongoose.Types.ObjectId | string
  email: string
  role?: string
  /** Org đang mở — task-26: orgContext đọc claim này để nạp Membership (BPMN Flow 10.6). */
  orgId?: string
}

/** Access token thật (cùng secret với `authMiddleware`). */
export const authAs = async (user: AuthUser): Promise<string> => {
  const { signAccessToken } = await import("../src/shared/auth/jwt.util.js")
  return signAccessToken({
    userId: String(user._id),
    email: user.email,
    ...(user.role ? { role: user.role } : {}),
    ...(user.orgId ? { orgId: user.orgId } : {})
  })
}

let seedCounter = 0

/**
 * Cùng các bước `src/scripts/seed-fixture.ts` (T02): user → project → Spine (validate `spineSchema`)
 * → đúng một chat session `is_pipeline` → ví credit. Trả về id + token để gọi API.
 */
export const seedFixture = async (kind: FixtureKind = "full", options: SeedOptions = {}): Promise<SeededFixture> => {
  const [
    { User },
    { Project },
    { ChatSession },
    { Spine },
    { spineSchema },
    { CreditWallet },
    { Organization },
    { Membership }
  ] = await Promise.all([
    import("../src/modules/user/user.model.js"),
    import("../src/modules/project/project.model.js"),
    import("../src/modules/project/chat-session.model.js"),
    import("../src/modules/spine/spine.model.js"),
    import("../src/modules/spine/spine.schema.js"),
    import("../src/modules/credits/credit-wallet.model.js"),
    import("../src/modules/organization/organization.model.js"),
    import("../src/modules/organization/membership.model.js")
  ])

  const raw = readFixtureJson<Record<string, unknown>>(FIXTURE_FILES[kind])
  options.mutate?.(raw)
  const spine = spineSchema.parse(raw)

  seedCounter += 1
  const user = await User.create({
    email: options.email ?? `fixture-${seedCounter}-${Date.now()}@flintflow.test`,
    password: "fixture-password-123",
    name: "Fixture User",
    emailVerified: true,
    emailVerifiedAt: new Date()
  })
  // task-26: mọi fixture sống trong một org 1 thành viên, user là Lead — đúng mô hình mặc định của sản phẩm.
  const organization = await Organization.create({ name: "Fixture Org", ownerUserId: user._id })
  await Membership.create({ organizationId: organization._id, userId: user._id, role: "lead" })

  const project = await Project.create({
    userId: user._id,
    organizationId: organization._id,
    name: kind === "full" ? "FlintFlow (Fixture 19 Screens)" : "FlintFlow (Fixture Minimal)",
    domain: spine.project.domain
  })
  if (!options.withoutSpine) {
    await Spine.create({ projectId: project._id, ...spine })
  }
  const session = await ChatSession.create({ projectId: project._id, messages: [], is_pipeline: true })
  if (options.balance !== null) {
    await CreditWallet.create({
      userId: user._id,
      organizationId: organization._id,
      balance: options.balance ?? 1000,
      reserved: 0
    })
  }

  return {
    user: { _id: user._id as mongoose.Types.ObjectId, email: user.email, role: user.role },
    userId: String(user._id),
    orgId: String(organization._id),
    projectId: String(project._id),
    sessionId: String(session._id),
    spineVersion: spine.spine_version,
    token: await authAs({
      _id: user._id as mongoose.Types.ObjectId,
      email: user.email,
      orgId: String(organization._id)
    })
  }
}

// ─── HTTP ───────────────────────────────────────────────────────────

/** Bóc envelope `{ data, meta, error }` của API. */
export interface Envelope<T = unknown> {
  data: T
  meta?: Record<string, unknown>
  error: { code: string; message: string } | null
}

/** Tách luồng SSE (`event:`/`data:`) thành mảng event JSON. */
export const parseSse = (text: string): Array<Record<string, unknown>> =>
  text
    .split(/\n\n+/)
    .map((block) =>
      block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("")
    )
    .filter((payload) => payload.length > 0)
    .flatMap((payload) => {
      try {
        return [JSON.parse(payload) as Record<string, unknown>]
      } catch {
        return []
      }
    })
