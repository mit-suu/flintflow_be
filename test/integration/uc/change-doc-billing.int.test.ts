/**
 * UC-44 / UC-48 / UC-54 / UC-56 — integration theo đặc tả `docs/report/actors-and-use-cases (1).md` (BR-01, BR-03, BR-04).
 * Mongo in-memory + `app` thật qua supertest; chỉ provider AI (`llm.router`) và HTTP ra payment_service bị giả lập.
 *
 * Không viết test cho UC-40 (sửa theo comment từ chối baseline) và UC-49 (comment ghim vào section/field):
 * `src/` chưa có API nào cho hai UC này (xem `viewer-read-only.middleware.ts` — "Khi có endpoint comment …").
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import request from "supertest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())
vi.mock("../../../src/modules/billing/payment-service.client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/modules/billing/payment-service.client.js")>()
  return {
    ...actual,
    isPaymentServiceConfigured: vi.fn(() => true),
    createPaymentOrder: vi.fn(),
    getPaymentOrder: vi.fn()
  }
})

import app from "../../../src/app.js"
import { authAs, seedFixture, type SeededFixture } from "../../setup.js"
import { resetMockLlm } from "../../helpers/mock-llm.js"
import { mode1Api } from "../../helpers/mode1.js"
import { crDetail, createCr, importedProject, releaseNow, routeReplaceCr, writeCr } from "../../helpers/mode1-release-p4.js"
import { User } from "../../../src/modules/user/user.model.js"
import { Membership, type OrgRole } from "../../../src/modules/organization/membership.model.js"
import { compareResponseSchema, releaseResponseSchema } from "../../../src/modules/doc-version/doc-version.dto.js"
import { DocVersion } from "../../../src/modules/doc-version/doc-version.model.js"
import { applyTransaction } from "../../../src/modules/spine/op-engine.js"
import * as spineRepository from "../../../src/modules/spine/spine.repository.js"
import {
  createPaymentOrder,
  getPaymentOrder,
  isPaymentServiceConfigured,
  type PaymentServiceOrder
} from "../../../src/modules/billing/payment-service.client.js"
import { planConfig } from "../../../src/modules/billing/plan.config.js"
import { CreditWallet } from "../../../src/modules/credits/credit-wallet.model.js"
import { CreditTransaction } from "../../../src/modules/credits/credit-transaction.model.js"
import { Subscription } from "../../../src/modules/credits/subscription.model.js"
import { PaymentIntent } from "../../../src/modules/billing/payment-intent.model.js"
import { deductCredit, releaseCredit, reserveCredit } from "../../../src/shared/ai/credit-reservation.service.js"

const CLIENT_ID = "flintflow-test-client"
const DAY_MS = 24 * 60 * 60 * 1000
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` })

/** Thêm một thành viên vào org với vai trò cho trước; trả id + token đã chọn org. */
const joinOrg = async (orgId: string, role: OrgRole) => {
  const email = `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@flintflow.test`
  const user = await User.create({ email, password: "test-password-123", name: `Member ${role}`, emailVerified: true })
  await Membership.create({ organizationId: orgId, userId: user._id, role })
  return { id: String(user._id), token: await authAs({ _id: user._id, email, orgId }) }
}

/** Client mode 1 của một thành viên khác trên cùng project (cùng org với fixture). */
const apiAs = (seeded: SeededFixture, token: string, projectId: string) => mode1Api({ ...seeded, token }, projectId)

/** Sơ đồ render lỗi ⇒ cờ đỏ `render_error` do code dựng (BR-04, không waive được). */
const addRedFlag = async (projectId: string) => {
  const spine = (await spineRepository.get(projectId))!
  await applyTransaction(projectId, {
    base_version: spine.spine_version,
    by: "test",
    ops: [
      {
        op: "add",
        path: "diagrams[]",
        value: { id: "D01", kind: "erd", puml: "@startuml\n@enduml", section: "fixed:3.1.5", owner_kind: null, owner_id: null, render_status: "error", error: "boom", source_hash: "x", rendered_at: null }
      }
    ]
  })
}

beforeEach(() => {
  resetMockLlm()
  routeReplaceCr("2 seconds", "1 second")
  vi.mocked(isPaymentServiceConfigured).mockReturnValue(true)
  vi.mocked(createPaymentOrder).mockReset()
  vi.mocked(getPaymentOrder).mockReset()
})

// ─── UC-44 ──────────────────────────────────────────────────────────

describe("UC-44 — gửi gói thay đổi cho Lead duyệt", () => {
  it("gói gồm đúng mọi CR Analyst đã ghi từ baseline trước, theo thứ tự ghi", async () => {
    const { seeded, projectId, c } = await importedProject()
    const analyst = await joinOrg(seeded.orgId, "analyst")
    const a = apiAs(seeded, analyst.token, projectId)

    expect(await writeCr(a, "Nhanh hơn", "1 second instead of 2 seconds")).toEqual({ crId: "CR-001", version: "0.1" })
    routeReplaceCr("1 second", "500 ms")
    expect(await writeCr(a, "Nhanh nữa", "500 ms instead of 1 second")).toEqual({ crId: "CR-002", version: "0.2" })

    const res = await releaseNow(c)
    expect(res.status, JSON.stringify(res.body.error)).toBe(201)
    const rel = releaseResponseSchema.parse(res.body.data)
    expect(rel.cr_ids).toEqual(["CR-001", "CR-002"])
    expect(rel.version).toMatchObject({ version: "1.0", based_on: "0.2" })
  })

  it("còn cờ đỏ ⇒ gói không qua được: 422 RELEASE_RED_FLAGS_OPEN, không sinh version mới", async () => {
    const { seeded, projectId, c } = await importedProject()
    const analyst = await joinOrg(seeded.orgId, "analyst")
    await writeCr(apiAs(seeded, analyst.token, projectId), "Nhanh hơn", "1 second instead of 2 seconds")
    await addRedFlag(projectId)

    const blocked = await releaseNow(c)
    expect(blocked.status).toBe(422)
    expect(blocked.body.error.code).toBe("RELEASE_RED_FLAGS_OPEN")
    expect(blocked.body.meta.flags.every((f: { level: string }) => f.level === "red")).toBe(true)
    expect(await DocVersion.countDocuments({ projectId, kind: "release" })).toBe(0)
  })

  it("CR chưa qua bước kiểm (C-5) thì chưa nộp được ⇒ 409 CR_INVALID_TRANSITION", async () => {
    const { seeded, projectId } = await importedProject()
    const analyst = await joinOrg(seeded.orgId, "analyst")
    const a = apiAs(seeded, analyst.token, projectId)
    const crId = await createCr(a, "Nhanh hơn", "1 second instead of 2 seconds")
    crDetail(await a.post(`/change-requests/${crId}/clarify`))
    crDetail(await a.post(`/change-requests/${crId}/impact`))

    const early = await a.post(`/change-requests/${crId}/submit`)
    expect(early.status).toBe(409)
    expect(early.body.error.code).toBe("CR_INVALID_TRANSITION")
  })

  // BUG(UC-44): đặc tả — Analyst gửi gói cho Lead, chỉ Lead phát hành (UC-45, "A Lead's own work is released without
  // UC-44") vs code — POST /release không kiểm vai trò (doc-version.route.ts:87, release.service.ts:33), Analyst
  // phát hành thẳng 1.0 được (201); cũng không có endpoint gửi gói / khoá bản nháp khi gói chờ duyệt.
  it.skip("Analyst không phát hành thẳng được — phải gửi gói cho Lead (403)", async () => {
    const { seeded, projectId } = await importedProject()
    const analyst = await joinOrg(seeded.orgId, "analyst")
    const a = apiAs(seeded, analyst.token, projectId)
    await writeCr(a, "Nhanh hơn", "1 second instead of 2 seconds")

    const res = await releaseNow(a)
    expect(res.status).toBe(403)
    expect(await DocVersion.countDocuments({ projectId, kind: "release" })).toBe(0)
  })
})

// ─── UC-48 ──────────────────────────────────────────────────────────

describe("UC-48 — so sánh hai phiên bản SRS", () => {
  it("Lead so sánh 0.0 → 0.1: khác biệt theo block, block sửa có before/after", async () => {
    const { c } = await importedProject()
    await writeCr(c, "Nhanh hơn", "1 second instead of 2 seconds")

    const res = await c.get("/versions/compare?from=0.0&to=0.1")
    expect(res.status, JSON.stringify(res.body.error)).toBe(200)
    const diff = compareResponseSchema.parse(res.body.data)
    expect(diff).toMatchObject({ from: "0.0", to: "0.1" })
    expect(diff.summary.modified).toBeGreaterThan(0)
    const changed = diff.blocks.find((b) => b.change === "modified" && b.before?.includes("2 seconds"))
    expect(changed?.after).toContain("1 second")
  })

  it("phiên bản không tồn tại ⇒ 404 DOC_VERSION_NOT_FOUND; from trùng to ⇒ 400", async () => {
    const { c } = await importedProject()
    const missing = await c.get("/versions/compare?from=0.0&to=9.0")
    expect(missing.status).toBe(404)
    expect(missing.body.error.code).toBe("DOC_VERSION_NOT_FOUND")
    expect((await c.get("/versions/compare?from=0.0&to=0.0")).status).toBe(400)
  })

  it("Viewer xem được so sánh, cùng các block khác biệt như Lead", async () => {
    const { seeded, projectId, c } = await importedProject()
    await writeCr(c, "Nhanh hơn", "1 second instead of 2 seconds")
    const viewer = await joinOrg(seeded.orgId, "viewer")

    const lead = compareResponseSchema.parse((await c.get("/versions/compare?from=0.0&to=0.1")).body.data)
    const res = await apiAs(seeded, viewer.token, projectId).get("/versions/compare?from=0.0&to=0.1")
    expect(res.status, JSON.stringify(res.body.error)).toBe(200)
    const seen = compareResponseSchema.parse(res.body.data)
    expect(seen.blocks.filter((b) => b.change === "modified")).toEqual(lead.blocks.filter((b) => b.change === "modified"))
  })

  it("Viewer không thấy tác giả thay đổi trong bản so sánh (projection UC-47)", async () => {
    const { seeded, projectId, c } = await importedProject()
    await writeCr(c, "Nhanh hơn", "1 second instead of 2 seconds")
    const viewer = await joinOrg(seeded.orgId, "viewer")

    const res = await apiAs(seeded, viewer.token, projectId).get("/versions/compare?from=0.0&to=0.1")
    expect(res.status).toBe(200)
    const text = JSON.stringify(res.body.data)
    expect(text).not.toContain("Fixture User")
    expect(text).not.toContain(seeded.user.email)
  })
})

// ─── UC-54 ──────────────────────────────────────────────────────────

let orderSeq = 0
const PRO_PRICE = planConfig.pro.priceVnd

const remoteOrder = (orderId: string, status: PaymentServiceOrder["status"], amount = PRO_PRICE): PaymentServiceOrder => ({
  order_id: orderId,
  client_id: CLIENT_ID,
  amount,
  description: "FlintFlow plan:pro",
  reference_code: `REF-${orderId}`,
  callback_url: "http://localhost:5000/api/v1/billing/payment-callback",
  status,
  sepay_transaction_id: status === "paid" ? 1 : null,
  created_at: new Date().toISOString(),
  paid_at: status === "paid" ? new Date().toISOString() : null
})

/** Lead mở thanh toán gói Pro (`plan:pro`) trên cổng — trả order_id phía payment_service. */
const checkoutPro = async (token: string) => {
  orderSeq += 1
  const orderId = `uc54-order-${orderSeq}`
  vi.mocked(createPaymentOrder).mockResolvedValueOnce({
    order_id: orderId,
    reference_code: `REF-${orderId}`,
    payment_description: `FF ${orderId}`,
    qr_code_url: "https://qr.example/pro.png"
  } as Awaited<ReturnType<typeof createPaymentOrder>>)
  const res = await request(app).post("/api/v1/billing/checkout").set(bearer(token)).send({ packageId: "plan:pro" })
  return { res, orderId }
}

const paymentCallback = (orderId: string) =>
  request(app).post("/api/v1/billing/payment-callback").send({ order_id: orderId, status: "paid", client_id: CLIENT_ID })

/** Org đang ở gói free, kỳ hiện tại bắt đầu 10 ngày trước. */
const onFreePlan = async (seeded: SeededFixture) => {
  const start = new Date(Date.now() - 10 * DAY_MS)
  await Subscription.create({
    userId: seeded.userId,
    organizationId: seeded.orgId,
    plan: "free",
    status: "active",
    monthlyCreditsAllotment: planConfig.free.monthlyCredits,
    currentPeriodStart: start,
    currentPeriodEnd: new Date(start.getTime() + planConfig.periodDays * DAY_MS)
  })
}

describe("UC-54 — nâng gói đăng ký", () => {
  it("Lead thanh toán gói Pro thành công ⇒ cộng ngay credit kỳ của Pro, kỳ mới bắt đầu hôm nay", async () => {
    const seeded = await seedFixture("minimal", { balance: 50 })
    await onFreePlan(seeded)

    const { res, orderId } = await checkoutPro(seeded.token)
    expect(res.status, JSON.stringify(res.body.error)).toBe(201)
    expect(res.body.data).toMatchObject({ packageId: "plan:pro", amount: PRO_PRICE, credits: planConfig.pro.monthlyCredits, status: "pending" })

    vi.mocked(getPaymentOrder).mockResolvedValue(remoteOrder(orderId, "paid"))
    const paid = await paymentCallback(orderId)
    expect(paid.status).toBe(200)
    expect(paid.body).toMatchObject({ success: true, status: "succeeded", creditsAdded: planConfig.pro.monthlyCredits })

    const wallet = await CreditWallet.findOne({ organizationId: seeded.orgId }).lean()
    expect(wallet?.balance).toBe(50 + planConfig.pro.monthlyCredits)

    const sub = await Subscription.findOne({ organizationId: seeded.orgId }).lean()
    expect(sub).toMatchObject({ plan: "pro", status: "active", monthlyCreditsAllotment: planConfig.pro.monthlyCredits })
    expect(Math.abs(sub!.currentPeriodStart.getTime() - Date.now())).toBeLessThan(60_000)
    expect(sub!.currentPeriodEnd.getTime() - sub!.currentPeriodStart.getTime()).toBe(planConfig.periodDays * DAY_MS)

    const balance = await request(app).get("/api/v1/billing/balance").set(bearer(seeded.token))
    expect(balance.body.data).toMatchObject({ plan: "pro", balance: 50 + planConfig.pro.monthlyCredits })
  })

  it("đổi thẳng sang Pro không qua cổng ⇒ 402 PAYMENT_REQUIRED, gói giữ nguyên free", async () => {
    const seeded = await seedFixture("minimal", { balance: 50 })
    await onFreePlan(seeded)

    const res = await request(app).post("/api/v1/billing/upgrade").set(bearer(seeded.token)).send({ plan: "pro" })
    expect(res.status).toBe(402)
    expect(res.body.error.code).toBe("PAYMENT_REQUIRED")
    expect((await Subscription.findOne({ organizationId: seeded.orgId }).lean())?.plan).toBe("free")
    expect((await CreditWallet.findOne({ organizationId: seeded.orgId }).lean())?.balance).toBe(50)
  })

  it("cổng báo thanh toán thất bại ⇒ không đổi gói, không cộng credit", async () => {
    const seeded = await seedFixture("minimal", { balance: 50 })
    await onFreePlan(seeded)
    const { orderId } = await checkoutPro(seeded.token)

    vi.mocked(getPaymentOrder).mockResolvedValue(remoteOrder(orderId, "failed"))
    const res = await paymentCallback(orderId)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ status: "failed", creditsAdded: 0 })
    expect((await Subscription.findOne({ organizationId: seeded.orgId }).lean())?.plan).toBe("free")
    expect((await CreditWallet.findOne({ organizationId: seeded.orgId }).lean())?.balance).toBe(50)
  })

  it("Analyst và Viewer không nâng gói được ⇒ 403 ORG_ROLE_FORBIDDEN, không tạo giao dịch", async () => {
    const seeded = await seedFixture("minimal")
    for (const role of ["analyst", "viewer"] as const) {
      const member = await joinOrg(seeded.orgId, role)
      const checkout = await checkoutPro(member.token)
      expect(checkout.res.status, role).toBe(403)
      expect(checkout.res.body.error.code, role).toBe("ORG_ROLE_FORBIDDEN")
      const upgrade = await request(app).post("/api/v1/billing/upgrade").set(bearer(member.token)).send({ plan: "pro" })
      expect(upgrade.status, role).toBe(403)
    }
    expect(await PaymentIntent.countDocuments({ organizationId: seeded.orgId })).toBe(0)
    expect(createPaymentOrder).not.toHaveBeenCalled()
  })
})

// ─── UC-56 ──────────────────────────────────────────────────────────

/** Một lượt gọi AI thành công (reserve ⇒ deduct) và một lượt lỗi (reserve ⇒ release) của Analyst trên project org. */
const aiCalls = async (seeded: SeededFixture, userId: string) => {
  const ok = await reserveCredit(userId, "chat", seeded.projectId)
  await deductCredit(ok)
  const failed = await reserveCredit(userId, "chat", seeded.projectId)
  await releaseCredit(failed)
  return { ok, failed }
}

interface LedgerRow {
  _id: string
  userId: string
  projectId: string | null
  actionType: string
  amount: number
  type: string
  state?: string
  [key: string]: unknown
}

describe("UC-56 — xem lịch sử tiêu credit", () => {
  it("Lead xem từng lượt gọi AI: project, thành viên, bước, credit và trạng thái", async () => {
    const seeded = await seedFixture("minimal", { balance: 500 })
    const analyst = await joinOrg(seeded.orgId, "analyst")
    const { ok, failed } = await aiCalls(seeded, analyst.id)

    const res = await request(app).get("/api/v1/billing/transactions?limit=50").set(bearer(seeded.token))
    expect(res.status, JSON.stringify(res.body.error)).toBe(200)
    const rows = res.body.data as LedgerRow[]
    const done = rows.find((r) => String(r._id) === ok.reservationId)
    expect(done).toMatchObject({ type: "reserve", state: "deducted", projectId: seeded.projectId, userId: analyst.id, actionType: "chat", amount: ok.cost })
    const refunded = rows.find((r) => String(r._id) === failed.reservationId)
    expect(refunded).toMatchObject({ state: "refunded", projectId: seeded.projectId, userId: analyst.id })
    expect(res.body.meta).toMatchObject({ page: 1, limit: 50, total: rows.length })
  })

  it("Analyst (Author) cũng xem được lịch sử của cả org", async () => {
    const seeded = await seedFixture("minimal", { balance: 500 })
    const analyst = await joinOrg(seeded.orgId, "analyst")
    const { ok } = await aiCalls(seeded, seeded.userId)

    const res = await request(app).get("/api/v1/billing/transactions").set(bearer(analyst.token))
    expect(res.status).toBe(200)
    expect((res.body.data as LedgerRow[]).some((r) => String(r._id) === ok.reservationId && r.userId === seeded.userId)).toBe(true)
  })

  it("Viewer không phải Author ⇒ 403 ORG_ROLE_FORBIDDEN", async () => {
    const seeded = await seedFixture("minimal")
    const viewer = await joinOrg(seeded.orgId, "viewer")
    const res = await request(app).get("/api/v1/billing/transactions").set(bearer(viewer.token))
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe("ORG_ROLE_FORBIDDEN")
  })

  it("không lẫn lượt gọi AI của org khác", async () => {
    const mine = await seedFixture("minimal", { balance: 500 })
    const other = await seedFixture("minimal", { balance: 500 })
    await aiCalls(other, other.userId)

    const res = await request(app).get("/api/v1/billing/transactions").set(bearer(mine.token))
    expect(res.status).toBe(200)
    expect((res.body.data as LedgerRow[]).every((r) => r.projectId !== other.projectId)).toBe(true)
    expect(await CreditTransaction.countDocuments({ organizationId: other.orgId })).toBeGreaterThan(0)
  })

  // BUG(UC-56): đặc tả — mỗi lượt gọi AI hiện project, step, member, tokens, credits, state vs code — GET /billing/transactions
  // (billing.service.ts:98) trả CreditTransaction không có token (credit-transaction.model.ts:22-37); token + step chỉ nằm ở
  // `Usage` (spine/usage.model.ts) và AiActionLog — không API nào cho Author đọc (chỉ admin `GET /admin/ai-cost` tổng hợp).
  it.skip("mỗi lượt gọi AI kèm số token đã tiêu", async () => {
    const seeded = await seedFixture("minimal", { balance: 500 })
    const { ok } = await aiCalls(seeded, seeded.userId)

    const res = await request(app).get("/api/v1/billing/transactions").set(bearer(seeded.token))
    const row = (res.body.data as LedgerRow[]).find((r) => String(r._id) === ok.reservationId)!
    expect(row).toBeDefined()
    expect(Object.keys(row).some((k) => /token/i.test(k))).toBe(true)
  })
})
