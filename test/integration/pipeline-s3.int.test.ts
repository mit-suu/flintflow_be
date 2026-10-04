/**
 * pipeline-s3 (T22) — endpoint 3, 4, 6 qua HTTP: S-1.2…S-3.6 trên fixture minimal với provider giả ở
 * tầng `callLLM`. Reserve/trừ/hoàn credit, `Usage`, `AiActionLog` là code thật trên Mongo thật.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import request from "supertest"

vi.mock("../../src/shared/ai/providers/llm.router.js", async () =>
  (await import("../helpers/mock-llm.js")).mockLlmRouterModule()
)

import app from "../../src/app.js"
import { seedFixture } from "../setup.js"
import { mockCalls, mockOverrides, resetMockLlm } from "../helpers/mock-llm.js"
import { gateHttp, runStepHttp, spineVersionOf, startAt } from "../helpers/pipeline.js"
import { gateResponseSchema, stepEventSchema, stepsResponseSchema } from "../../src/modules/pipeline/pipeline.dto.js"
import { Usage } from "../../src/modules/spine/usage.model.js"
import { CreditWallet } from "../../src/modules/credits/credit-wallet.model.js"
import { AiActionLog } from "../../src/modules/admin/ai-action-log.model.js"
import { Spine } from "../../src/modules/spine/spine.model.js"
import { ChatSession } from "../../src/modules/project/chat-session.model.js"
import { StepRun } from "../../src/modules/pipeline/run-state.model.js"

/** Chuỗi T14: op-case của S-3.x tham chiếu id do S-1.2/S-2.x sinh ra nên phải chạy từ S-1.2. */
const S3_STEPS = ["S-1.2", "S-2.1", "S-2.2", "S-2.3", "S-2.4", "S-2.5", "S-3.1", "S-3.2", "S-3.3", "S-3.4", "S-3.5", "S-3.6"] as const

beforeEach(() => {
  resetMockLlm()
})

describe("S-1.2 → S-3.6 qua /run + /gate", () => {
  it("mỗi step: SSE hợp lệ tới gate_ready, accept chuyển sang step kế; credit trừ đúng tổng Usage", { timeout: 120_000 }, async () => {
    const seeded = await seedFixture("minimal", { mutate: startAt("S-1.2", S3_STEPS) })

    for (const [i, stepId] of S3_STEPS.entries()) {
      const run = await runStepHttp(app, seeded, stepId, await spineVersionOf(app, seeded))
      expect(run.status).toBe(200)
      expect(run.errorCode, `${stepId}: ${JSON.stringify(run.events[run.events.length - 1])}`).toBeNull()
      run.events.forEach((e) => stepEventSchema.parse(e))
      expect(run.events[run.events.length - 1]?.type, stepId).toBe("gate_ready")

      const gate = await gateHttp(app, seeded, stepId, await spineVersionOf(app, seeded))
      expect(gate.status, JSON.stringify(gate.body.error)).toBe(200)
      const accepted = gateResponseSchema.parse(gate.body.data)
      expect(accepted.step.status).toBe("accepted")
      if (i < S3_STEPS.length - 1) expect(accepted.next_step).toBe(S3_STEPS[i + 1])

      // S-2.5/S-3.6 chỉ render: test không có PlantUML ⇒ render_status "error" nhưng step vẫn tới gate (contract §2)
      if (stepId === "S-2.5" || stepId === "S-3.6") {
        const renders = run.events.filter((e) => e.type === "render")
        expect(renders.length, stepId).toBeGreaterThan(0)
      }
    }

    const spine = await Spine.findOne({ projectId: seeded.projectId }).lean()
    expect((spine?.actors ?? []).length).toBeGreaterThan(0)
    expect((spine?.use_cases ?? []).length).toBeGreaterThan(0)

    // Mỗi lượt gọi model ⇒ đúng một Usage `deducted` và một log success; ví trừ đúng tổng cost
    const usages = await Usage.find({ projectId: seeded.projectId }).lean()
    expect(usages.length).toBe(mockCalls.length)
    expect(usages.every((u) => u.state === "deducted")).toBe(true)
    expect(await AiActionLog.countDocuments({ projectId: seeded.projectId, status: "success" })).toBe(mockCalls.length)
    const spent = usages.reduce((sum, u) => sum + u.cost, 0)
    const wallet = await CreditWallet.findOne({ userId: seeded.userId }).lean()
    expect(wallet?.balance).toBe(1000 - spent)
    expect(wallet?.reserved).toBe(0)

    const steps = await request(app)
      .get(`/api/v1/projects/${seeded.projectId}/steps`)
      .set("Authorization", `Bearer ${seeded.token}`)
    const parsed = stepsResponseSchema.parse(steps.body.data)
    for (const stepId of S3_STEPS) expect(parsed.steps.find((s) => s.id === stepId)?.status).toBe("accepted")
  })
})

describe("FLF-249: lịch sử chat giữ lại tin cổng, không chỉ giữ thao tác của user", () => {
  /** Tin của lượt duyệt, theo thứ tự ghi — thẻ cổng do FE dựng từ lượt chạy sống nên chốt xong là mất. */
  const gateTurn = async (projectId: string): Promise<Array<{ role: string; content: string }>> => {
    const session = await ChatSession.findOne({ projectId, is_pipeline: true }).lean()
    return (session?.messages ?? []).map((m) => ({ role: m.role, content: m.content }))
  }

  it("duyệt một bước ⇒ transcript có tin cổng NGAY TRƯỚC thao tác của user", { timeout: 60_000 }, async () => {
    const seeded = await seedFixture("minimal", { mutate: startAt("S-3.1") })
    const run = await runStepHttp(app, seeded, "S-3.1", await spineVersionOf(app, seeded))
    const gateReady = run.events[run.events.length - 1] as { type: string; message_vi?: string }
    expect(gateReady.type).toBe("gate_ready")

    const gate = await gateHttp(app, seeded, "S-3.1", await spineVersionOf(app, seeded))
    expect(gate.status, JSON.stringify(gate.body.error)).toBe(200)

    const messages = await gateTurn(seeded.projectId)
    const action = messages.findIndex((m) => m.role === "user" && m.content === "Đúng rồi, đi tiếp")
    expect(action, "không thấy thao tác của user trong transcript").toBeGreaterThan(0)
    // Vế đầu của cùng một lượt duyệt: thiếu nó thì đọc lại chỉ thấy "Đúng rồi, đi tiếp" đứng một mình
    expect(messages[action - 1].role).toBe("ai")
    expect(messages[action - 1].content).toBe(gateReady.message_vi)
  })

  it("cổng không có tin ⇒ không ghi tin rỗng, thao tác của user vẫn vào transcript", { timeout: 60_000 }, async () => {
    const seeded = await seedFixture("minimal", { mutate: startAt("S-3.1") })
    await runStepHttp(app, seeded, "S-3.1", await spineVersionOf(app, seeded))
    await StepRun.updateOne({ projectId: seeded.projectId, step_id: "S-3.1" }, { $set: { gate_payload: {}, phase_gate: null } })

    const gate = await gateHttp(app, seeded, "S-3.1", await spineVersionOf(app, seeded))
    expect(gate.status, JSON.stringify(gate.body.error)).toBe(200)

    const messages = await gateTurn(seeded.projectId)
    expect(messages.filter((m) => m.content.trim() === "")).toEqual([])
    expect(messages.some((m) => m.role === "user" && m.content === "Đúng rồi, đi tiếp")).toBe(true)
  })
})

describe("lỗi của /run", () => {
  it("base_version cũ ⇒ 409 SPINE_VERSION_CONFLICT, không gọi model", async () => {
    const seeded = await seedFixture("minimal", { mutate: startAt("S-3.1") })
    const run = await runStepHttp(app, seeded, "S-3.1", seeded.spineVersion + 5)
    expect(run.errorCode).toBe("SPINE_VERSION_CONFLICT")
    expect(mockCalls).toHaveLength(0)
  })

  it("session không phải pipeline ⇒ NOT_PIPELINE_SESSION, không gọi model", async () => {
    const seeded = await seedFixture("minimal", { mutate: startAt("S-3.1") })
    const other = await ChatSession.create({ projectId: seeded.projectId, messages: [], is_pipeline: false })
    const run = await runStepHttp(app, seeded, "S-3.1", seeded.spineVersion, String(other._id))
    expect(run.errorCode).toBe("NOT_PIPELINE_SESSION")
    expect(mockCalls).toHaveLength(0)
  })

  it("ví 0 credit ⇒ INSUFFICIENT_CREDIT, không gọi model, không trừ, Spine không đổi", async () => {
    const seeded = await seedFixture("minimal", { mutate: startAt("S-3.1"), balance: 0 })
    const run = await runStepHttp(app, seeded, "S-3.1", seeded.spineVersion)
    expect(run.errorCode).toBe("INSUFFICIENT_CREDIT")
    expect(mockCalls).toHaveLength(0)
    expect(await Usage.countDocuments({ projectId: seeded.projectId, state: "deducted" })).toBe(0)
    const wallet = await CreditWallet.findOne({ userId: seeded.userId }).lean()
    expect(wallet).toMatchObject({ balance: 0, reserved: 0 })
    expect((await Spine.findOne({ projectId: seeded.projectId }).lean())?.actors).toEqual([])
  })

  it("provider lỗi ở mọi lần thử ⇒ event error, credit hoàn lại hết, không ghi op, log failed", async () => {
    const seeded = await seedFixture("minimal", { mutate: startAt("S-3.1") })
    mockOverrides.next = () => new Error("provider down (integration test)")

    const run = await runStepHttp(app, seeded, "S-3.1", seeded.spineVersion)
    expect(run.errorCode).not.toBeNull()
    expect(run.events.some((e) => e.type === "ops_applied")).toBe(false)

    const wallet = await CreditWallet.findOne({ userId: seeded.userId }).lean()
    expect(wallet).toMatchObject({ balance: 1000, reserved: 0 })
    expect(await Usage.countDocuments({ projectId: seeded.projectId, state: "deducted" })).toBe(0)
    expect(await AiActionLog.countDocuments({ projectId: seeded.projectId, status: "failed" })).toBeGreaterThan(0)
    expect((await Spine.findOne({ projectId: seeded.projectId }).lean())?.actors).toEqual([])
  })
})
