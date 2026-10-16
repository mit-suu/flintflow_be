/**
 * UC-27 / UC-28 / UC-30 — pha Product Brief (B-0 … B-2) qua HTTP thật: Mongo in-memory, provider AI giả ở tầng
 * `callLLM` (`test/helpers/mock-llm.ts`). Reserve/trừ/hoàn credit, `Usage`, sổ quyết định, khoá step là code thật.
 *
 * Spec: `docs/report/actors-and-use-cases (1).md` — UC-27, UC-28, UC-30, BR-01, BR-05, BR-08, BR-09, BR-10.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import request from "supertest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import app from "../../../src/app.js"
import { parseSse, seedFixture, type SeededFixture } from "../../setup.js"
import { detectCall, mockCalls, mockOverrides, resetMockLlm } from "../../helpers/mock-llm.js"
import { gateHttp, reachedGate, runStepHttp, spineVersionOf, startAt } from "../../helpers/pipeline.js"
import { createEmptySpine } from "../../../src/modules/spine/spine.repository.js"
import { Spine } from "../../../src/modules/spine/spine.model.js"
import { Usage } from "../../../src/modules/spine/usage.model.js"
import { CreditWallet } from "../../../src/modules/credits/credit-wallet.model.js"
import { ChatSession } from "../../../src/modules/project/chat-session.model.js"
import { Notification } from "../../../src/modules/notification/notification.model.js"
import { User } from "../../../src/modules/user/user.model.js"
import { Membership } from "../../../src/modules/organization/membership.model.js"
import { authAs } from "../../setup.js"
import { gateResponseSchema, stepEventSchema } from "../../../src/modules/pipeline/pipeline.dto.js"

type SseEvent = Record<string, unknown> & { type: string }

const IDEA =
  "Ghi chú cuộc họp với chủ tiệm: cần app đặt lịch cắt tóc cho 3 chi nhánh, khách đặt online, thợ xem lịch trong ngày, chủ tiệm xem doanh thu."

/** Project mới chỉ có ý tưởng (UC-16 → UC-27): Spine rỗng, con trỏ ở B-0.1. */
const emptyBrief = (spine: Record<string, unknown>): void => {
  Object.assign(spine, createEmptySpine({ name: "Đặt lịch cắt tóc", domain: null }))
}

const emptyBriefAt = (stepId: string) => (spine: Record<string, unknown>) => {
  emptyBrief(spine)
  startAt(stepId)(spine)
}

const auth = (seeded: SeededFixture) => ({ Authorization: `Bearer ${seeded.token}` })
const base = (seeded: SeededFixture) => `/api/v1/projects/${seeded.projectId}`

/** `/run` có tin chat (SSE) — trả về promise để test trả lời câu hỏi giữa lượt. */
const startRun = async (seeded: SeededFixture, stepId: string, body: Record<string, unknown> = {}) => {
  const baseVersion = await spineVersionOf(app, seeded)
  return request(app)
    .post(`${base(seeded)}/steps/${stepId}/run`)
    .set(auth(seeded))
    .send({ session_id: seeded.sessionId, base_version: baseVersion, ...body })
    .then((res) => ({ status: res.status, events: parseSse(res.text ?? "") as SseEvent[], body: res.body }))
}

const runState = async (seeded: SeededFixture, stepId: string) =>
  (await request(app).get(`${base(seeded)}/steps/${stepId}/run-state`).set(auth(seeded))).body.data as Record<string, unknown> | null

/** Chờ lượt chạy đạt trạng thái (vd `waiting_answer`) — poll `GET /run-state` như FE sau reload. */
const waitForStatus = async (seeded: SeededFixture, stepId: string, status: string, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const state = await runState(seeded, stepId)
    if (state?.status === status) return state
    if (Date.now() > deadline) throw new Error(`${stepId} không tới ${status}: ${JSON.stringify(state)}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

const answer = (seeded: SeededFixture, stepId: string, answers: { question_id: string; answer: string }[]) =>
  request(app).post(`${base(seeded)}/steps/${stepId}/answer`).set(auth(seeded)).send({ session_id: seeded.sessionId, answers })

const spineOf = async (seeded: SeededFixture) => Spine.findOne({ projectId: seeded.projectId }).lean()
const stepStatus = async (seeded: SeededFixture, stepId: string) => (await spineOf(seeded))?.steps.find((s) => s.id === stepId)?.status ?? "pending"

/** Câu hỏi elicit giả: một thẻ có lựa chọn, mang `topic_key` để sổ quyết định theo dõi. */
const PAYMENT_QUESTION = {
  question: "Khách đặt cọc bằng cách nào?",
  topic_key: "payment_method",
  options: [
    { label: "Chuyển khoản (Khuyến nghị)", description: "Đối soát được" },
    { label: "Tiền mặt tại tiệm", description: "Không cần cổng thanh toán" }
  ]
}

/** Draft B-0.1 giả: bóc ý tưởng thành addendum, KHÔNG chốt nền tảng (để B-0.2 còn field trống). */
const B01_DRAFT = {
  notes: "Tôi đã ghi lại ý tưởng đặt lịch cắt tóc cho 3 chi nhánh.",
  ops: [
    {
      op: "add",
      path: "addendum[]",
      value: {
        id: "AD01",
        topic: "Ý tưởng",
        content: "App đặt lịch cắt tóc cho 3 chi nhánh.",
        content_en: "A haircut booking app for three branches.",
        target_section: "fixed:1",
        captured_at: "2026-10-01T00:00:00.000Z"
      }
    }
  ]
}

beforeEach(() => {
  resetMockLlm()
})

// ─── UC-27 ──────────────────────────────────────────────────────────

describe("UC-27 — nhập yêu cầu stakeholder (B-0.1)", () => {
  it("nhập ghi chú cuộc họp ⇒ tin vào transcript B-0.1, AI đọc đúng tin, bóc thành addendum và dừng ở cổng chốt ý tưởng", { timeout: 60_000 }, async () => {
    const seeded = await seedFixture("minimal", { mutate: emptyBrief })
    const prompts: { kind: string; step: string | null; text: string }[] = []
    mockOverrides.next = (prompt) => {
      const { kind, stepId } = detectCall(prompt)
      prompts.push({ kind, step: stepId, text: prompt })
      if (kind === "draft" && stepId === "B-0.1") return JSON.stringify(B01_DRAFT)
      return undefined
    }

    const run = await startRun(seeded, "B-0.1", { message: IDEA })
    expect(run.status).toBe(200)
    run.events.forEach((e) => stepEventSchema.parse(e))
    expect(run.events.some((e) => e.type === "error"), JSON.stringify(run.events.find((e) => e.type === "error"))).toBe(false)

    // Tin của stakeholder là đầu vào của Brief: nằm trong transcript và tới tay AI
    const session = await ChatSession.findById(seeded.sessionId).lean()
    expect(session?.messages.find((m) => m.role === "user")).toMatchObject({ content: IDEA, step: "B-0.1" })
    expect(prompts.find((p) => p.kind === "elicit" && p.step === "B-0.1")?.text).toContain(IDEA)

    // AI bóc tách thành dữ liệu có cấu trúc, không để trong tin nhắn
    const spine = await spineOf(seeded)
    expect(spine?.addendum.map((a) => a.id)).toEqual(["AD01"])

    // B-0.1 luôn là cổng thật: user chốt ý tưởng, không tự Accept
    const gate = run.events.at(-1)
    expect(gate?.type).toBe("gate_ready")
    expect(gate?.auto).toBeFalsy()
    expect(await stepStatus(seeded, "B-0.1")).toBe("in_progress")
    expect((await runState(seeded, "B-0.1"))?.status).toBe("gate")
  })

  it("chưa có ý tưởng ⇒ AI hỏi gợi mở bằng văn xuôi; trả lời bằng ý tưởng ⇒ soạn và tới cổng", { timeout: 60_000 }, async () => {
    const seeded = await seedFixture("minimal", { mutate: emptyBrief })
    mockOverrides.next = (prompt) => {
      const { kind, stepId } = detectCall(prompt)
      if (kind === "elicit" && stepId === "B-0.1") {
        return JSON.stringify({
          reply: "Mình gợi ý vài hướng nhé.",
          questions: [{ question: "Công việc hằng ngày của bạn có việc gì mất thời gian?", topic_key: "daily_pain", options: [] }]
        })
      }
      if (kind === "draft" && stepId === "B-0.1") return JSON.stringify(B01_DRAFT)
      return undefined
    }

    const running = startRun(seeded, "B-0.1", { message: "Mình chưa có ý tưởng", intent: "no_idea" })
    const waiting = await waitForStatus(seeded, "B-0.1", "waiting_answer")
    const questions = waiting.questions as { id: string; options?: unknown }[]
    expect(questions).toHaveLength(1)
    expect(questions[0].options).toBeUndefined()
    // Chưa trả lời thì chưa soạn gì
    expect(mockCalls.filter((c) => c.kind === "draft")).toHaveLength(0)

    const sent = await answer(seeded, "B-0.1", [{ question_id: questions[0].id, answer: IDEA }])
    expect(sent.status, JSON.stringify(sent.body)).toBe(200)

    const run = await running
    expect(run.events.at(-1)?.type, JSON.stringify(run.events.at(-1))).toBe("gate_ready")
    expect(mockCalls.filter((c) => c.kind === "draft" && c.step_id === "B-0.1")).toHaveLength(1)
    expect((await spineOf(seeded))?.addendum).toHaveLength(1)
  })

  it("Viewer không nhập được yêu cầu (403), không ghi gì vào transcript", async () => {
    const seeded = await seedFixture("minimal", { mutate: emptyBrief })
    const viewer = await User.create({ email: "viewer-uc27@flintflow.test", password: "test-password-123", emailVerified: true })
    await Membership.create({ organizationId: seeded.orgId, userId: viewer._id, role: "viewer" })
    const token = await authAs({ _id: viewer._id, email: viewer.email, orgId: seeded.orgId })

    const res = await request(app)
      .post(`${base(seeded)}/steps/B-0.1/run`)
      .set({ Authorization: `Bearer ${token}` })
      .send({ session_id: seeded.sessionId, base_version: await spineVersionOf(app, seeded), message: IDEA })
    expect(res.status).toBe(403)
    expect(mockCalls).toHaveLength(0)
    expect((await ChatSession.findById(seeded.sessionId).lean())?.messages).toEqual([])
  })

  it("ý tưởng chưa chốt (B-0.1 chưa duyệt) ⇒ không nhảy sang B-1.1 được (409 STEP_NOT_RUNNABLE)", async () => {
    const seeded = await seedFixture("minimal", { mutate: emptyBrief })
    const run = await runStepHttp(app, seeded, "B-1.1", await spineVersionOf(app, seeded))
    expect(run.status).toBe(409)
    expect(run.errorCode).toBe("STEP_NOT_RUNNABLE")
    expect(mockCalls).toHaveLength(0)
  })
})

// ─── UC-28 ──────────────────────────────────────────────────────────

describe("UC-28 — hoàn thiện Product Brief (B-0 … B-1)", () => {
  it("AI hỏi điều còn thiếu; trả lời qua /answer ⇒ ghi sổ quyết định, soạn tới cổng; mỗi lượt gọi giữ rồi trừ đúng credit (UC-57)", { timeout: 60_000 }, async () => {
    const seeded = await seedFixture("minimal", { mutate: emptyBrief })
    mockOverrides.next = (prompt) => {
      const { kind, stepId } = detectCall(prompt)
      if (kind === "elicit" && stepId === "B-0.1") return JSON.stringify({ reply: "Cho mình hỏi thêm một ý.", questions: [PAYMENT_QUESTION] })
      if (kind === "draft" && stepId === "B-0.1") return JSON.stringify(B01_DRAFT)
      return undefined
    }

    const running = startRun(seeded, "B-0.1", { message: IDEA })
    const waiting = await waitForStatus(seeded, "B-0.1", "waiting_answer")
    const [question] = waiting.questions as { id: string; text: string }[]
    expect(question.text).toBe(PAYMENT_QUESTION.question)

    const sent = await answer(seeded, "B-0.1", [{ question_id: question.id, answer: "Chuyển khoản" }])
    expect(sent.status).toBe(200)
    expect(sent.body.data).toEqual({ accepted: true })

    const run = await running
    expect(run.events.some((e) => e.type === "answer_received")).toBe(true)
    expect(run.events.at(-1)?.type, JSON.stringify(run.events.at(-1))).toBe("gate_ready")

    const spine = await spineOf(seeded)
    expect(spine?.decisions).toEqual([expect.objectContaining({ topic_key: "payment_method", answer: "Chuyển khoản", step_id: "B-0.1", superseded_by: null })])

    // BR-01 / UC-57: mỗi lượt gọi model (elicit + draft) ⇒ đúng một Usage đã trừ; ví trừ đúng tổng, không còn giữ
    expect(mockCalls.map((c) => c.kind).sort()).toEqual(["draft", "elicit"])
    const usages = await Usage.find({ projectId: seeded.projectId }).lean()
    expect(usages).toHaveLength(mockCalls.length)
    expect(usages.every((u) => u.state === "deducted")).toBe(true)
    const spent = usages.reduce((sum, u) => sum + u.cost, 0)
    expect(spent).toBeGreaterThan(0)
    expect(await CreditWallet.findOne({ organizationId: seeded.orgId }).lean()).toMatchObject({ balance: 1000 - spent, reserved: 0 })
  })

  it("chủ đề đã trả lời không bị hỏi lại ở bước sau: server bỏ câu trùng, sổ quyết định có trong prompt", { timeout: 60_000 }, async () => {
    const seeded = await seedFixture("minimal", { mutate: emptyBrief })
    const elicitPrompts: Record<string, string> = {}
    mockOverrides.next = (prompt) => {
      const { kind, stepId } = detectCall(prompt)
      if (kind === "elicit" && stepId) elicitPrompts[stepId] = prompt
      // Model "quên" sổ và hỏi lại đúng chủ đề đã chốt ở mọi bước
      if (kind === "elicit") return JSON.stringify({ reply: "Cho mình hỏi thêm.", questions: [PAYMENT_QUESTION] })
      if (kind === "draft" && stepId === "B-0.1") return JSON.stringify(B01_DRAFT)
      return undefined
    }

    const running = startRun(seeded, "B-0.1", { message: IDEA })
    const waiting = await waitForStatus(seeded, "B-0.1", "waiting_answer")
    await answer(seeded, "B-0.1", [{ question_id: (waiting.questions as { id: string }[])[0].id, answer: "Chuyển khoản" }])
    expect((await running).events.at(-1)?.type).toBe("gate_ready")
    const accepted = await gateHttp(app, seeded, "B-0.1", await spineVersionOf(app, seeded))
    expect(accepted.status, JSON.stringify(accepted.body.error)).toBe(200)
    expect(accepted.body.data.next_step).toBe("B-0.2")

    // B-0.2 còn thiếu nền tảng ⇒ có gọi elicit, nhưng câu về chủ đề đã chốt bị bỏ ⇒ không hỏi user lần nữa
    const run = await runStepHttp(app, seeded, "B-0.2", await spineVersionOf(app, seeded))
    expect(run.errorCode, JSON.stringify(run.events.at(-1))).toBeNull()
    expect(elicitPrompts["B-0.2"]).toBeDefined()
    expect(elicitPrompts["B-0.2"]).toContain("payment_method")
    expect(run.events.some((e) => e.type === "answer_needed")).toBe(false)
    expect(reachedGate(run.events), JSON.stringify(run.events.at(-1))).toBe(true)
    expect((await spineOf(seeded))?.decisions.filter((d) => d.topic_key === "payment_method")).toHaveLength(1)
  })

  it("nền tảng đã có trong đầu vào ⇒ B-0.2 không hỏi lại, không gọi model, không tốn credit", { timeout: 60_000 }, async () => {
    const seeded = await seedFixture("minimal", {
      mutate: (spine) => {
        emptyBriefAt("B-0.2")(spine)
        ;(spine.project as Record<string, unknown>).form_factor = ["mobile_app"]
      }
    })
    const run = await runStepHttp(app, seeded, "B-0.2", await spineVersionOf(app, seeded))
    expect(run.errorCode).toBeNull()
    expect(reachedGate(run.events), JSON.stringify(run.events.at(-1))).toBe(true)
    expect(run.events.some((e) => e.type === "answer_needed")).toBe(false)
    expect(mockCalls).toHaveLength(0)
    expect(await Usage.countDocuments({ projectId: seeded.projectId })).toBe(0)
    expect(await CreditWallet.findOne({ organizationId: seeded.orgId }).lean()).toMatchObject({ balance: 1000, reserved: 0 })
  })

  it("ví hết credit ⇒ INSUFFICIENT_CREDIT, bước dừng giữ nguyên tiến độ, không tự chạy lại khi có credit; user chạy lại thì tiếp tục", { timeout: 60_000 }, async () => {
    const seeded = await seedFixture("minimal", { mutate: emptyBriefAt("B-1.1"), balance: 0 })
    const before = await spineOf(seeded)

    const run = await runStepHttp(app, seeded, "B-1.1", await spineVersionOf(app, seeded))
    expect(run.errorCode).toBe("INSUFFICIENT_CREDIT")
    expect(run.events.find((e) => e.type === "error")?.retryable).toBe(true)
    expect(mockCalls).toHaveLength(0)

    // Tiến độ giữ nguyên: các bước đã duyệt vẫn accepted, nội dung Brief không đổi, ví không bị giữ
    const after = await spineOf(seeded)
    for (const id of ["B-0.1", "B-0.2", "B-0.3"]) expect(after?.steps.find((s) => s.id === id)?.status, id).toBe("accepted")
    expect(after?.addendum).toEqual(before?.addendum)
    expect(await CreditWallet.findOne({ organizationId: seeded.orgId }).lean()).toMatchObject({ balance: 0, reserved: 0 })
    expect((await runState(seeded, "B-1.1"))?.status).not.toBe("running")

    // Lead nạp credit: bước đang dừng không tự chạy lại (BR-08)
    await CreditWallet.updateOne({ organizationId: seeded.orgId }, { $set: { balance: 1000 } })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(mockCalls).toHaveLength(0)

    // Author chạy lại (UC-22) ⇒ bước đi tiếp tới cổng
    const again = await runStepHttp(app, seeded, "B-1.1", await spineVersionOf(app, seeded))
    expect(again.errorCode, JSON.stringify(again.events.at(-1))).toBeNull()
    expect(reachedGate(again.events), JSON.stringify(again.events.at(-1))).toBe(true)
    expect(mockCalls.length).toBeGreaterThan(0)
  })

  // BUG(UC-28/UC-57): spec BR-01 + UC-57 "balance insufficient → … the organization's Leads are notified to top up"
  // vs code: pipeline (step-runner/meter, executeAiAction → reserveCredit, src/shared/ai/credit-reservation.service.ts:186)
  // chỉ ném INSUFFICIENT_CREDIT; `notifyTopUpNeeded` (src/modules/import/credit-flow.service.ts:56) chỉ được gọi ở mode 1
  // (src/modules/import/metered-ai.ts), không có ở pipeline Brief/SRS.
  it.skip("ví hết credit ở bước Brief ⇒ báo các Lead của tổ chức nạp thêm", { timeout: 60_000 }, async () => {
    const seeded = await seedFixture("minimal", { mutate: emptyBriefAt("B-1.1"), balance: 0 })
    const run = await runStepHttp(app, seeded, "B-1.1", await spineVersionOf(app, seeded))
    expect(run.errorCode).toBe("INSUFFICIENT_CREDIT")

    const deadline = Date.now() + 3000
    let notes: unknown[] = []
    while (Date.now() < deadline) {
      notes = await Notification.find({ userId: seeded.userId, type: "credit_topup_needed" }).lean()
      if (notes.length > 0) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(notes.length).toBeGreaterThan(0)
  })
})

// ─── UC-30 ──────────────────────────────────────────────────────────

describe("UC-30 — duyệt Product Brief (B-2.3)", () => {
  it("brief chưa duyệt ⇒ bước phân tích/soạn SRS (S-1.1, S-2.1) bị khoá: 409 STEP_NOT_RUNNABLE, không gọi model", async () => {
    const seeded = await seedFixture("minimal", { mutate: startAt("B-2.3") })
    for (const stepId of ["S-1.1", "S-2.1"]) {
      const run = await runStepHttp(app, seeded, stepId, await spineVersionOf(app, seeded))
      expect(run.status, stepId).toBe(409)
      expect(run.errorCode, stepId).toBe("STEP_NOT_RUNNABLE")
    }
    expect(mockCalls).toHaveLength(0)
  })

  it("B-2.3 tới cổng nhưng chưa bấm duyệt ⇒ S-1.1 vẫn khoá; duyệt ⇒ B-2.3 accepted, mở S-1.1 và chạy được", { timeout: 90_000 }, async () => {
    const seeded = await seedFixture("minimal", { mutate: startAt("B-2.3") })

    const review = await runStepHttp(app, seeded, "B-2.3", await spineVersionOf(app, seeded))
    expect(review.errorCode, JSON.stringify(review.events.at(-1))).toBeNull()
    const gateReady = review.events.at(-1)
    expect(gateReady?.type).toBe("gate_ready")
    // Duyệt Brief là quyết định của người: không tự Accept
    expect(gateReady?.auto).toBeFalsy()

    const locked = await runStepHttp(app, seeded, "S-1.1", await spineVersionOf(app, seeded))
    expect(locked.errorCode).toBe("STEP_NOT_RUNNABLE")

    const approved = await gateHttp(app, seeded, "B-2.3", await spineVersionOf(app, seeded))
    expect(approved.status, JSON.stringify(approved.body.error)).toBe(200)
    const data = gateResponseSchema.parse(approved.body.data)
    expect(data.step).toMatchObject({ id: "B-2.3", status: "accepted" })
    expect(data.step.accepted_at).not.toBeNull()
    expect(data.next_step).toBe("S-1.1")

    const steps = await request(app).get(`${base(seeded)}/steps`).set(auth(seeded))
    expect(steps.body.data.current_step).toBe("S-1.1")

    const next = await runStepHttp(app, seeded, "S-1.1", await spineVersionOf(app, seeded))
    expect(next.status).toBe(200)
    expect(next.errorCode, JSON.stringify(next.events.at(-1))).toBeNull()
    expect(next.events.at(-1)?.type).toBe("gate_ready")
  })

  it("duyệt khi B-2.3 chưa chạy tới cổng ⇒ 409 STEP_NOT_RUNNABLE, Brief chưa được duyệt", async () => {
    const seeded = await seedFixture("minimal", { mutate: startAt("B-2.3") })
    const res = await gateHttp(app, seeded, "B-2.3", await spineVersionOf(app, seeded))
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("STEP_NOT_RUNNABLE")
    expect(await stepStatus(seeded, "B-2.3")).toBe("pending")
  })

  it("duyệt với base_version cũ ⇒ 409 SPINE_VERSION_CONFLICT, B-2.3 vẫn chờ duyệt", { timeout: 60_000 }, async () => {
    const seeded = await seedFixture("minimal", { mutate: startAt("B-2.3") })
    const review = await runStepHttp(app, seeded, "B-2.3", await spineVersionOf(app, seeded))
    expect(review.events.at(-1)?.type).toBe("gate_ready")

    const stale = (await spineVersionOf(app, seeded)) - 1
    const res = await gateHttp(app, seeded, "B-2.3", stale)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("SPINE_VERSION_CONFLICT")
    expect(await stepStatus(seeded, "B-2.3")).toBe("in_progress")
  })

  // BUG(UC-30): spec UC-30 + BR-01 "The system then reports the estimated drafting credits for confirmation (estimated
  // after the brief is approved)" vs code: gate accept trả `{ step, next_step, spine_version }` (src/modules/pipeline/gate.service.ts:451,
  // gateResponseSchema src/modules/pipeline/pipeline.dto.ts:473) — không có ước tính credit soạn SRS, cũng không có endpoint nào
  // ước tính theo số màn (chỉ `/ai-actions/estimate-cost` theo một actionType).
  it.skip("duyệt Brief xong ⇒ hệ thống báo ước tính credit soạn SRS để xác nhận", { timeout: 60_000 }, async () => {
    const seeded = await seedFixture("minimal", { mutate: startAt("B-2.3") })
    const review = await runStepHttp(app, seeded, "B-2.3", await spineVersionOf(app, seeded))
    expect(review.events.at(-1)?.type).toBe("gate_ready")

    const approved = await gateHttp(app, seeded, "B-2.3", await spineVersionOf(app, seeded))
    expect(approved.status).toBe(200)
    const estimateKey = Object.keys(approved.body.data).find((key) => /estimat/i.test(key))
    expect(estimateKey, "gate B-2.3 phải kèm ước tính credit soạn SRS").toBeDefined()
    expect(Number(approved.body.data[estimateKey as string]?.credits ?? approved.body.data[estimateKey as string])).toBeGreaterThan(0)
  })
})
