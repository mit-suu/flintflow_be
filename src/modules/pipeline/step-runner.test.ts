import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect, vi, beforeEach } from "vitest"

/** Store trong bộ nhớ thay model Mongoose Spine/Change — cùng ngữ nghĩa diagram.service.test.ts. */
const db = vi.hoisted(() => {
  type Doc = Record<string, unknown>
  type Filter = Record<string, unknown>
  const spines: Doc[] = []
  const changes: Doc[] = []
  const usages: Doc[] = []
  const sessions: Doc[] = []
  let usageSeq = 0
  const copy = <X>(x: X): X => structuredClone(x)
  const matches = (doc: Doc, filter: Filter): boolean =>
    Object.entries(filter).every(([key, expected]) => {
      const actual = doc[key]
      if (typeof expected === "object" && expected !== null) {
        const e = expected as { $gte?: number | string | Date; $lte?: number; $in?: unknown[]; $ne?: unknown }
        if (e.$in) return e.$in.map(String).includes(String(actual))
        if ("$ne" in e) return actual !== e.$ne
        if (e.$gte instanceof Date || typeof e.$gte === "string") return new Date(actual as string) >= new Date(e.$gte as string | Date)
        const n = Number(actual)
        return (e.$gte === undefined || n >= Number(e.$gte)) && (e.$lte === undefined || n <= e.$lte)
      }
      return String(actual) === String(expected)
    })
  const bySeq = (a: Doc, b: Doc) => Number(a.seq) - Number(b.seq)

  const Spine = {
    findOne: async (filter: Filter) => copy(spines.find((s) => matches(s, filter)) ?? null),
    exists: async (filter: Filter) => (spines.some((s) => matches(s, filter)) ? { _id: "x" } : null),
    findOneAndUpdate: async (filter: Filter, update: { $set?: Doc; $setOnInsert?: Doc }, options: { upsert?: boolean } = {}) => {
      const doc = spines.find((s) => matches(s, filter))
      if (doc) {
        Object.assign(doc, copy(update.$set ?? {}))
        return copy(doc)
      }
      if (!options.upsert) return null
      const created = { _id: "spine", ...filter, ...copy(update.$setOnInsert ?? {}) }
      spines.push(created)
      return copy(created)
    }
  }
  const Change = {
    findOne: async (filter: Filter, _p: unknown, options: { sort?: { seq?: number } } = {}) => {
      const rows = changes.filter((c) => matches(c, filter)).sort(bySeq)
      return copy((options.sort?.seq === -1 ? rows[rows.length - 1] : rows[0]) ?? null)
    },
    find: async (filter: Filter, _p: unknown, options: { sort?: { seq?: number } } = {}) => {
      const rows = changes.filter((c) => matches(c, filter)).sort(bySeq)
      return (options?.sort?.seq === -1 ? rows.slice().reverse() : rows).map(copy)
    },
    insertMany: async (docs: Doc[]) => {
      if (docs.some((d) => changes.some((c) => String(c.projectId) === String(d.projectId) && c.seq === d.seq))) {
        throw Object.assign(new Error("E11000"), { code: 11000 })
      }
      changes.push(...docs.map(copy))
      return docs.map(copy)
    },
    deleteMany: async () => ({})
  }
  const Usage = {
    insertMany: async (docs: Doc[]) => {
      const created = docs.map((d) => ({ _id: `u${++usageSeq}`, createdAt: new Date().toISOString(), ...copy(d) }))
      usages.push(...created)
      return created.map(copy)
    },
    updateMany: async (filter: Filter, update: { $set: Doc }) => {
      const matched = usages.filter((r) => matches(r, filter))
      for (const r of matched) Object.assign(r, copy(update.$set))
      return { modifiedCount: matched.length }
    },
    findOneAndUpdate: async (filter: Filter, update: { $set: Doc }) => {
      const row = usages.find((r) => matches(r, filter))
      if (!row) return null
      const before = copy(row)
      Object.assign(row, copy(update.$set))
      return before
    },
    countDocuments: async (filter: Filter) => usages.filter((r) => matches(r, filter)).length,
    // `meter.roundCost` (gate hiện "x credit") đọc thô các dòng usage của vòng
    find: (filter: Filter) => ({ lean: async () => usages.filter((r) => matches(r, filter)).map((r) => ({ cost: r.cost })) })
  }
  const withMethods = (doc: Doc | null) =>
    doc
      ? {
          ...copy(doc),
          save: async function (this: Doc) {
            Object.assign(sessions.find((s) => s._id === this._id)!, this)
          }
        }
      : null
  const ChatSession = {
    /** Trả object vừa await được trực tiếp, vừa hỗ trợ `.lean()` (context-projection dùng `.lean()`). */
    findById: (id: string, _proj?: unknown) => {
      const promise = Promise.resolve(withMethods(sessions.find((s) => s._id === id) ?? null)) as Promise<Doc | null> & { lean: () => Promise<Doc | null> }
      promise.lean = async () => copy(sessions.find((s) => s._id === id) ?? null)
      return promise
    },
    updateOne: async (filter: { _id: string }, update: Doc | { $push: { messages: unknown } }) => {
      const row = sessions.find((s) => s._id === filter._id)
      if (row) {
        if ("$push" in update) (row.messages as unknown[]).push((update as { $push: { messages: unknown } }).$push.messages)
        else Object.assign(row, update)
      }
      return { modifiedCount: row ? 1 : 0 }
    }
  }

  const reset = () => {
    spines.length = 0
    changes.length = 0
    usages.length = 0
    sessions.length = 0
    usageSeq = 0
  }
  return { Spine, Change, Usage, ChatSession, spines, changes, usages, sessions, reset }
})

vi.mock("../spine/spine.model.js", () => ({ Spine: db.Spine }))
vi.mock("../spine/change.model.js", () => ({ Change: db.Change }))
vi.mock("../spine/usage.model.js", () => ({ Usage: db.Usage }))
vi.mock("../project/chat-session.model.js", () => ({ ChatSession: db.ChatSession }))
vi.mock("../spine/op-engine.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../spine/op-engine.js")>()
  return { ...actual, applyTransaction: vi.fn(actual.applyTransaction) }
})
vi.mock("../../shared/ai/document-context.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/ai/document-context.service.js")>()
  return { ...actual, buildDocumentContext: vi.fn(async () => ({ contextText: "", tokenCount: 0, documentsUsed: 0, usedSummary: false })) }
})
vi.mock("../notification/notification.service.js", () => ({ notify: vi.fn(async () => null), notifyAdmins: vi.fn(async () => 0) }))
vi.mock("../../shared/ai/credit-reservation.service.js", () => ({ refundDeductedCredit: vi.fn(async () => undefined) }))

import { refundDeductedCredit } from "../../shared/ai/credit-reservation.service.js"
import { spineSchema } from "../spine/spine.schema.js"
import type { Spine as SpineT } from "../spine/spine.types.js"
import * as repo from "../spine/spine.repository.js"
import { applyTransaction } from "../spine/op-engine.js"
import { createMemoryDiagramStore } from "../diagram/diagram-file.store.js"
import type { DiagramServiceDeps } from "../diagram/diagram.service.js"
import type { CompileCheckResult } from "../../shared/diagram/compile-check.js"
import { orderedSteps } from "./step-registry.js"
import type { AiActionResult } from "../../shared/ai/ai-action.types.js"
import type { OpTransaction, ElicitOutput } from "../../shared/ai/response-parser.js"
import { runStep, submitAnswer, dropPendingAnswers, pendingAnswerFor, resumeWaitingStep, CALL_LIMIT, CHAT_BUDGET_REPLY, STEP_NOT_RUNNABLE, type StepRunnerDeps } from "./step-runner.service.js"
import { cancelRun, getRunState, resetMemoryRuns } from "./run-state.service.js"
import { gate } from "./gate.service.js"
import { resumeProject } from "./resume.service.js"
import { stepEventSchema, type StepEvent } from "./pipeline.dto.js"
import { ApiError } from "../../shared/utils/api-error.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.resolve(__dirname, "../../../fixtures")
const readJson = (...s: string[]): unknown => JSON.parse(fs.readFileSync(path.join(FIXTURES, ...s), "utf8"))
const MINIMAL: SpineT = spineSchema.parse(readJson("spine-fixture-minimal.json"))

const PROJECT = "650000000000000000000001"
const USER = "650000000000000000000010"
const SESSION = "sess-1"

/** Mọi step trước S-3 đánh dấu accepted, để `nextStep()` trả về S-3.1 mà không cần chạy B-0…S-2. */
const stepsBeforeS3 = () => {
  const all = orderedSteps({ screens: [], functions: [] })
  const idx = all.findIndex((s) => s.phase === "S-3")
  return all.slice(0, idx).map((s) => ({ id: s.id, status: "accepted" as const, first_seq: 1, last_seq: 1, accepted_at: "2026-01-01T00:00:00.000Z" }))
}

const seedSpine = () => {
  const spine = structuredClone(MINIMAL)
  spine.actors = [{ id: "A01", name: "Requester", kind: "human", description: "Người tạo yêu cầu" }]
  spine.progress.current_phase = "S-2"
  spine.progress.current_step = "S-2.4"
  spine.steps = stepsBeforeS3()
  db.spines[0] = { _id: "spine", projectId: PROJECT, ...spine }
}

const seedSession = (isPipeline: boolean) => {
  db.sessions.push({ _id: SESSION, projectId: PROJECT, messages: [], isActive: true, is_pipeline: isPipeline })
}

const elicitReply = (reply = "ok", questions: ElicitOutput["questions"] = []): AiActionResult<ElicitOutput> => ({
  success: true,
  data: { reply, questions },
  rawText: "{}",
  actionType: "elicit" as never,
  provider: "mock",
  aiModel: "mock",
  tokensUsed: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  latencyMs: 1,
  logId: "elicit-log",
  cost: 1
})

const draftReply = (ops: OpTransaction["ops"], notes?: string): AiActionResult<OpTransaction> => ({
  success: true,
  data: { ops, ...(notes ? { notes } : {}) },
  rawText: "{}",
  actionType: "draft" as never,
  provider: "mock",
  aiModel: "mock",
  tokensUsed: { promptTokens: 100, completionTokens: 40, totalTokens: 140 },
  latencyMs: 1,
  logId: "draft-log",
  cost: 4
})

const renderStub = (): Partial<DiagramServiceDeps> => {
  const store = createMemoryDiagramStore()
  const check: DiagramServiceDeps["check"] = async () =>
    ({ ok: true, method: "svg-scan", render: { format: "svg", data: Buffer.from("<svg/>"), contentType: "image/svg+xml", transport: "post", status: 200, diagnostics: {} } }) as CompileCheckResult
  return { check, renderPng: async () => Buffer.from("png"), store, now: () => new Date("2026-09-14T09:00:00.000Z") }
}

/** F20: mọi sự kiện `emit` phải khớp đúng `stepEventSchema` (hợp đồng SSE, pipeline-contract.md §2). */
const collectEvents = () => {
  const events: StepEvent[] = []
  const emit = (e: StepEvent) => {
    events.push(stepEventSchema.parse(e))
  }
  return { events, emit }
}

let actualApplyTransaction: typeof applyTransaction

beforeEach(async () => {
  resetMemoryRuns()
  db.reset()
  const actual = await vi.importActual<typeof import("../spine/op-engine.js")>("../spine/op-engine.js")
  actualApplyTransaction = actual.applyTransaction
  vi.mocked(applyTransaction).mockImplementation(actualApplyTransaction)
})

describe("step-runner: S-3.1 → S-3.6 qua runStep + gate accept (mock provider)", () => {
  it("chạy trọn 6 step; steps[]/changes[]/usage[] đúng", async () => {
    seedSpine()
    seedSession(true)
    const deps: Partial<StepRunnerDeps> = {
      elicitExecutor: async () => elicitReply(),
      draftExecutor: async (actionType, input) => {
        const stepId = (input.promptVariables as { step_id: string }).step_id
        if (stepId === "S-3.1") {
          return draftReply([{ op: "add", path: "actors[]", value: { id: "A02", name: "Approver", kind: "human", description: "Người duyệt" } }])
        }
        return draftReply([])
      },
      renderDeps: renderStub()
    }

    for (const stepId of ["S-3.1", "S-3.2", "S-3.3", "S-3.4", "S-3.5", "S-3.6"]) {
      const { events, emit } = collectEvents()
      await runStep(PROJECT, stepId, SESSION, USER, emit, deps)
      const gateReady = events.find((e) => e.type === "gate_ready")
      expect(gateReady, `${stepId} phải phát gate_ready`).toBeTruthy()

      const record = await repo.get(PROJECT)
      const gateResult = await gate(PROJECT, stepId, USER, { action: "accept", base_version: record!.spine_version })
      expect(gateResult.step.status).toBe("accepted")
    }

    const final = await repo.get(PROJECT)
    expect(final!.steps.filter((s) => s.id.startsWith("S-3.")).every((s) => s.status === "accepted")).toBe(true)
    expect(final!.actors.map((a) => a.id)).toContain("A02")

    // usage[]: elicit + draft mỗi step S-3.1..S-3.5 (S-3.6 không skill ⇒ không Elicit/Draft)
    const usageForS31 = db.usages.filter((u) => u.step_id === "S-3.1")
    expect(usageForS31.map((u) => u.call_kind).sort()).toEqual(["draft", "elicit"])
    expect(usageForS31.every((u) => u.state === "deducted")).toBe(true)
    const usageForS36 = db.usages.filter((u) => u.step_id === "S-3.6")
    expect(usageForS36).toHaveLength(0)

    // changes[]: step_id gắn đúng cho lô add actor
    const actorChange = db.changes.find((c) => c.path === "actors[]" || c.path === "actors[id=A02]")
    expect(actorChange?.step_id).toBe("S-3.1")
  })

  it("session không phải pipeline ⇒ 403 NOT_PIPELINE_SESSION, không gọi model", async () => {
    seedSpine()
    seedSession(false)
    const draftExecutor = vi.fn()
    const { emit } = collectEvents()

    const err = await runStep(PROJECT, "S-3.1", SESSION, USER, emit, { draftExecutor }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).statusCode).toBe(403)
    expect((err as ApiError).code).toBe("NOT_PIPELINE_SESSION")
    expect(draftExecutor).not.toHaveBeenCalled()
  })
})

describe("step-runner: CALL_LIMIT", () => {
  it("calls_used ≥ 8 ⇒ 409 CALL_LIMIT trước khi gọi model, không tiêu thêm lượt", async () => {
    seedSpine()
    seedSession(true)
    // Step đã in_progress với first_seq=2 (vòng hiện tại: mốc vòng = change TRƯỚC first_seq đặt
    // steps[id=S-3.1].status=in_progress — F1) + 8 usage đã deducted cho vòng đó, ghi SAU mốc vòng.
    db.spines[0].steps = [...(db.spines[0].steps as unknown[]), { id: "S-3.1", status: "in_progress", first_seq: 2, last_seq: 2, accepted_at: null }]
    db.changes.push({ projectId: PROJECT, seq: 1, txn: "t0", op: "set", path: "steps[id=S-3.1].status", before: "pending", value: "in_progress", reason: null, at: "2026-01-01T00:00:00.000Z", by: "system", step_id: "S-3.1" })
    for (let i = 1; i <= 8; i++) {
      db.usages.push({ _id: `pre${i}`, projectId: PROJECT, userId: USER, step_id: "S-3.1", call_kind: "draft", attempt: 1, tokens_in: 1, tokens_out: 1, cost: 1, state: "deducted", expires_at: "2099-01-01T00:00:00.000Z", logId: null, createdAt: "2026-01-01T00:01:00.000Z" })
    }

    const draftExecutor = vi.fn()
    const elicitExecutor = vi.fn()
    const { emit } = collectEvents()

    const err = await runStep(PROJECT, "S-3.1", SESSION, USER, emit, { draftExecutor, elicitExecutor }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).code).toBe(CALL_LIMIT)
    expect(draftExecutor).not.toHaveBeenCalled()
    expect(elicitExecutor).not.toHaveBeenCalled()
  })
})

describe("step-runner: 2 tab — SPINE_VERSION_CONFLICT hoàn usage, không tiêu trần", () => {
  it("applyTransaction 409 khi ghi ops Draft ⇒ usage của lượt đó refunded, không tính calls_used", async () => {
    seedSpine()
    seedSession(true)

    vi.mocked(applyTransaction).mockImplementation(async (projectId, txn) => {
      if (txn.ops.some((op) => op.path.startsWith("actors["))) {
        throw new ApiError(409, "Tài liệu vừa được thay đổi ở phiên khác.", repo.SPINE_VERSION_CONFLICT)
      }
      return actualApplyTransaction(projectId, txn)
    })

    const deps: Partial<StepRunnerDeps> = {
      elicitExecutor: async () => elicitReply(),
      draftExecutor: async () => draftReply([{ op: "add", path: "actors[]", value: { id: "A03", name: "Conflicted", kind: "human", description: "x" } }]),
      renderDeps: renderStub()
    }
    const { emit } = collectEvents()

    const err = await runStep(PROJECT, "S-3.1", SESSION, USER, emit, deps).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).code).toBe(repo.SPINE_VERSION_CONFLICT)

    const draftUsage = db.usages.filter((u) => u.step_id === "S-3.1" && u.call_kind === "draft")
    expect(draftUsage).toHaveLength(1)
    expect(draftUsage[0].state).toBe("refunded")
    const elicitUsage = db.usages.filter((u) => u.step_id === "S-3.1" && u.call_kind === "elicit")
    expect(elicitUsage[0]?.state).toBe("deducted")
    // Credit của lượt Draft được hoàn về ví (XREQ-local-1), lượt Elicit thì không.
    expect(refundDeductedCredit).toHaveBeenCalledTimes(1)
    expect(refundDeductedCredit).toHaveBeenCalledWith(expect.objectContaining({ userId: USER, actionType: "draft", amount: draftUsage[0].cost }))
  })
})

describe("step-runner: POST /answer", () => {
  it("submitAnswer resolves lượt chờ answer_needed đang treo; không có lượt chờ ⇒ false", () => {
    expect(submitAnswer(PROJECT, "S-3.1", SESSION, { answers: [{ question_id: "Q1", answer: "x" }] })).toBe(false)
  })

  it("F18: waitForAnswer/submitAnswer — elicit trả questions ⇒ answer_needed, submitAnswer từ ngoài đưa luồng tới gate_ready", async () => {
    seedSpine()
    seedSession(true)
    const deps: Partial<StepRunnerDeps> = {
      elicitExecutor: async () => elicitReply("Bạn muốn actor nào?", [{ question: "Actor chính là ai?", header: undefined, options: [], multiple: false }]),
      draftExecutor: async () => draftReply([]),
      renderDeps: renderStub()
    }
    const { events, emit } = collectEvents()

    const runPromise = runStep(PROJECT, "S-3.1", SESSION, USER, emit, deps)

    // Chờ tới khi answer_needed thực sự được emit (không đoán độ trễ bằng setTimeout cố định).
    for (let i = 0; i < 50 && !events.some((e) => e.type === "answer_needed"); i++) {
      await new Promise((r) => setTimeout(r, 0))
    }
    const answerNeeded = events.find((e) => e.type === "answer_needed")
    expect(answerNeeded).toBeTruthy()
    const questionId = (answerNeeded as Extract<StepEvent, { type: "answer_needed" }>).questions[0]!.id

    const accepted = submitAnswer(PROJECT, "S-3.1", SESSION, { answers: [{ question_id: questionId, answer: "Người quản trị" }] })
    expect(accepted).toBe(true)

    await runPromise
    expect(events.some((e) => e.type === "gate_ready")).toBe(true)

    const session = db.sessions.find((s) => s._id === SESSION)!
    const userMsgs = (session.messages as { role: string; content: string }[]).filter((m) => m.role === "user")
    expect(userMsgs.some((m) => m.content === "Người quản trị")).toBe(true)
  })
})

describe("step-runner: F1 — usage Elicit ghi TRƯỚC change nội dung đầu tiên vẫn được tính vào calls_used", () => {
  it("gate_ready.calls_used đếm cả elicit lẫn draft (bug cũ: mốc vòng = change first_seq, loại mất elicit)", async () => {
    seedSpine()
    seedSession(true)
    const deps: Partial<StepRunnerDeps> = {
      elicitExecutor: async () => elicitReply(),
      draftExecutor: async () => draftReply([{ op: "add", path: "actors[]", value: { id: "A09", name: "X", kind: "human", description: "d" } }]),
      renderDeps: renderStub()
    }
    const { events, emit } = collectEvents()

    await runStep(PROJECT, "S-3.1", SESSION, USER, emit, deps)

    const gateReady = events.find((e) => e.type === "gate_ready") as Extract<StepEvent, { type: "gate_ready" }>
    expect(gateReady.calls_used).toBe(2) // elicit + draft — cả hai đều phải tính, không riêng draft
  })
})

describe("step-runner: khoá step theo lượt chạy (F2 + FLF-177 WP-4)", () => {
  it("hai runStep đồng thời cùng step ⇒ request thứ hai 409 STEP_NOT_RUNNABLE, không đụng model; request đầu chạy trọn vẹn", async () => {
    seedSpine()
    seedSession(true)
    const deps: Partial<StepRunnerDeps> = {
      elicitExecutor: async () => elicitReply(),
      draftExecutor: async () => draftReply([]),
      renderDeps: renderStub()
    }
    const { events: events1, emit: emit1 } = collectEvents()
    const { emit: emit2 } = collectEvents()

    const p1 = runStep(PROJECT, "S-3.1", SESSION, USER, emit1, deps)
    const err2 = await runStep(PROJECT, "S-3.1", SESSION, USER, emit2, deps).catch((e: unknown) => e)

    expect(err2).toBeInstanceOf(ApiError)
    expect((err2 as ApiError).statusCode).toBe(409)
    expect((err2 as ApiError).code).toBe(STEP_NOT_RUNNABLE)

    await p1 // không ném — request đầu (giữ khoá) chạy trọn vẹn
    expect(events1.some((e) => e.type === "gate_ready")).toBe(true)
  })
})

describe("step-runner: trạng thái lượt chạy (FLF-177 BUG-05, BUG-07, BUG-32)", () => {
  it("phát stage theo từng giai đoạn và answer_received ngay khi nhận trả lời", async () => {
    seedSpine()
    seedSession(true)
    const deps: Partial<StepRunnerDeps> = {
      elicitExecutor: async () => elicitReply("Hỏi", [{ question: "Actor chính là ai?", header: undefined, options: [], multiple: false }]),
      draftExecutor: async () => draftReply([]),
      renderDeps: renderStub()
    }
    const { events, emit } = collectEvents()
    const run = runStep(PROJECT, "S-3.1", SESSION, USER, emit, deps)

    for (let i = 0; i < 50 && !events.some((e) => e.type === "answer_needed"); i++) await new Promise((r) => setTimeout(r, 0))
    // Đang chờ trả lời: run-state giữ câu hỏi để reload dựng lại đúng form (BUG-07)
    const waiting = await getRunState(PROJECT, "S-3.1")
    expect(waiting).toMatchObject({ status: "waiting_answer", stage: "ask" })
    expect(waiting?.questions).toHaveLength(1)

    submitAnswer(PROJECT, "S-3.1", SESSION, { answers: [{ question_id: "Q1", answer: "Quản trị viên" }] })
    await run

    const stages = events.filter((e) => e.type === "stage").map((e) => (e as Extract<StepEvent, { type: "stage" }>).stage)
    expect(stages).toContain("intake")
    expect(stages).toContain("ask")
    expect(stages).toContain("draft")
    expect(stages).toContain("gate")
    // BUG-32: trạng thái đổi ngay khi nhận trả lời, không đợi tới lượt draft
    const answerReceived = events.findIndex((e) => e.type === "answer_received")
    const firstDraft = events.findIndex((e) => e.type === "draft")
    expect(answerReceived).toBeGreaterThan(-1)
    expect(answerReceived).toBeLessThan(firstDraft)

    // Tới gate: khoá đã nhả, gate payload giữ lại để reload dựng lại thẻ duyệt
    const atGate = await getRunState(PROJECT, "S-3.1")
    expect(atGate).toMatchObject({ status: "gate", stage: "gate" })
    expect(atGate?.gate_payload).toMatchObject({ type: "gate_ready" })
    expect((atGate?.gate_payload as { no_change_reason?: string }).no_change_reason).toBeTruthy()
  })

  it("huỷ lượt đang chờ trả lời ⇒ nhả khoá, chạy lại được ngay (BUG-05)", async () => {
    seedSpine()
    seedSession(true)
    const controller = new AbortController()
    const deps: Partial<StepRunnerDeps> = {
      elicitExecutor: async () => elicitReply("Hỏi", [{ question: "Actor chính là ai?", header: undefined, options: [], multiple: false }]),
      draftExecutor: async () => draftReply([]),
      renderDeps: renderStub(),
      signal: controller.signal,
      abort: controller
    }
    const { events, emit } = collectEvents()
    const run = runStep(PROJECT, "S-3.1", SESSION, USER, emit, deps).catch((e: unknown) => e)
    for (let i = 0; i < 50 && !events.some((e) => e.type === "answer_needed"); i++) await new Promise((r) => setTimeout(r, 0))

    const cancelled = await cancelRun(PROJECT, "S-3.1")
    expect(cancelled.cancelled).toBe(true)
    expect(controller.signal.aborted).toBe(true)
    expect(await run).toBeInstanceOf(ApiError)

    // Chạy lại ngay, không phải chờ hết thời gian chờ trả lời
    const { events: events2, emit: emit2 } = collectEvents()
    await runStep(PROJECT, "S-3.1", SESSION, USER, emit2, { ...deps, signal: undefined, abort: undefined, elicitExecutor: async () => elicitReply() })
    expect(events2.some((e) => e.type === "gate_ready")).toBe(true)
  })
})

describe("step-runner: sổ quyết định (FLF-208 R4 — BUG-21)", () => {
  const askUptime = (topic = "uptime") =>
    elicitReply("Hỏi", [{ question: "Mức uptime mong muốn?", options: [], multiple: false, topic_key: topic } as never])

  const runAndAnswer = async (stepId: string, answer: string, elicit: () => ReturnType<typeof elicitReply>) => {
    const { events, emit } = collectEvents()
    const run = runStep(PROJECT, stepId, SESSION, USER, emit, {
      elicitExecutor: async () => elicit(),
      draftExecutor: async () => draftReply([]),
      renderDeps: renderStub()
    })
    for (let i = 0; i < 50 && !events.some((e) => e.type === "answer_needed"); i++) await new Promise((r) => setTimeout(r, 0))
    if (events.some((e) => e.type === "answer_needed")) submitAnswer(PROJECT, stepId, SESSION, { answers: [{ question_id: "Q1", answer }] })
    await run
    return events
  }

  it("câu trả lời được ghi vào sổ; step sau hỏi lại cùng chủ đề thì câu hỏi bị bỏ", async () => {
    seedSpine()
    seedSession(true)

    await runAndAnswer("S-3.1", "99%", () => askUptime())
    const afterFirst = (await repo.get(PROJECT))!
    expect(afterFirst.decisions).toHaveLength(1)
    expect(afterFirst.decisions[0]).toMatchObject({ topic_key: "uptime", answer: "99%", step_id: "S-3.1" })

    // Step sau hỏi lại đúng chủ đề đó (kể cả dưới tên khác) ⇒ user không bị hỏi lần hai
    await gate(PROJECT, "S-3.1", USER, { action: "accept", base_version: afterFirst.spine_version })
    const events = await runAndAnswer("S-3.2", "99%", () => askUptime("availability"))
    expect(events.some((e) => e.type === "answer_needed")).toBe(false)
    expect(events.some((e) => e.type === "gate_ready")).toBe(true)
    expect((await repo.get(PROJECT))!.decisions).toHaveLength(1)
  })

  it("Spine đổi ở nơi khác trong lúc chờ user trả lời ⇒ vẫn ghi sổ và tới gate, không 409", async () => {
    seedSpine()
    seedSession(true)
    const { events, emit } = collectEvents()
    const run = runStep(PROJECT, "S-3.1", SESSION, USER, emit, {
      elicitExecutor: async () => askUptime(),
      draftExecutor: async () => draftReply([]),
      renderDeps: renderStub()
    })
    for (let i = 0; i < 50 && !events.some((e) => e.type === "answer_needed"); i++) await new Promise((r) => setTimeout(r, 0))

    // User đổi chế độ duyệt ở menu AI trong lúc thẻ hỏi đang mở
    const current = (await repo.get(PROJECT))!
    await applyTransaction(PROJECT, { base_version: current.spine_version, ops: [{ op: "set", path: "project.review_mode", value: "strict" }], by: USER, step_id: null, reason: "đổi cách duyệt" })

    submitAnswer(PROJECT, "S-3.1", SESSION, { answers: [{ question_id: "Q1", answer: "99%" }] })
    await run
    expect(events.some((e) => e.type === "error")).toBe(false)
    expect(events.some((e) => e.type === "gate_ready")).toBe(true)
    expect((await repo.get(PROJECT))!.decisions[0]).toMatchObject({ topic_key: "uptime", answer: "99%" })
  })
})

describe("step-runner: F8 — client đóng kết nối (AbortSignal)", () => {
  it("signal đã abort TRƯỚC khi gọi model ⇒ dừng ngay, không gọi elicit/draft", async () => {
    seedSpine()
    seedSession(true)
    const controller = new AbortController()
    controller.abort()
    const elicitExecutor = vi.fn()
    const draftExecutor = vi.fn()
    const { emit } = collectEvents()

    const err = await runStep(PROJECT, "S-3.1", SESSION, USER, emit, { elicitExecutor, draftExecutor, signal: controller.signal }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).code).toBe(STEP_NOT_RUNNABLE)
    expect(elicitExecutor).not.toHaveBeenCalled()
    expect(draftExecutor).not.toHaveBeenCalled()
  })
})

describe("step-runner: S-8.2 Document Assembly ghép tài liệu", () => {
  /** Mọi step đứng trước `stepId` accepted, để `nextStep()` trả đúng `stepId`. */
  const seedUpTo = (stepId: string) => {
    seedSpine()
    const spine = db.spines[0] as unknown as SpineT
    const all = orderedSteps(spine)
    spine.steps = all
      .slice(0, all.findIndex((s) => s.id === stepId))
      .map((s) => ({ id: s.id, status: "accepted" as const, first_seq: 1, last_seq: 1, accepted_at: "2026-01-01T00:00:00.000Z" }))
    spine.progress.current_phase = "S-8"
  }

  it("S-8.2 gọi assembleDocument ở spine_version hiện tại rồi mới phát gate_ready; không gọi model", async () => {
    seedUpTo("S-8.2")
    seedSession(true)
    const order: string[] = []
    const assembleDocument = vi.fn(async () => {
      order.push("assemble")
    })
    const draftExecutor = vi.fn()
    const elicitExecutor = vi.fn()
    const { events, emit } = collectEvents()

    await runStep(PROJECT, "S-8.2", SESSION, USER, (e) => {
      if (e.type === "gate_ready") order.push("gate_ready")
      emit(e)
    }, { assembleDocument, draftExecutor, elicitExecutor, renderDeps: renderStub() })

    const record = await repo.get(PROJECT)
    expect(assembleDocument).toHaveBeenCalledTimes(1)
    expect(assembleDocument).toHaveBeenCalledWith(PROJECT, record!.spine_version)
    expect(order).toEqual(["assemble", "gate_ready"])
    expect(events[events.length - 1]?.type).toBe("gate_ready")
    expect(draftExecutor).not.toHaveBeenCalled()
    expect(elicitExecutor).not.toHaveBeenCalled()
  })

  it("assemble lỗi ⇒ runStep ném lỗi, không phát gate_ready", async () => {
    seedUpTo("S-8.2")
    seedSession(true)
    const { events, emit } = collectEvents()
    const assembleDocument = vi.fn(async () => {
      throw new ApiError(404, "Không tìm thấy Spine của dự án", "SPINE_NOT_FOUND")
    })

    const err = await runStep(PROJECT, "S-8.2", SESSION, USER, emit, { assembleDocument, renderDeps: renderStub() }).catch((e: unknown) => e)
    expect((err as ApiError).code).toBe("SPINE_NOT_FOUND")
    expect(events.some((e) => e.type === "gate_ready")).toBe(false)
  })

  it("Screens Flow đã có mà cũ (vd quyền S-4.3 đổi actor của màn) ⇒ step đang chạy tự vẽ lại; không cũ ⇒ không vẽ", async () => {
    seedUpTo("S-8.3")
    seedSession(true)
    const spine = db.spines[0] as unknown as SpineT
    spine.diagrams = spine.diagrams.filter((d) => d.kind !== "screen_flow")
    spine.diagrams.push({
      id: "D90", kind: "screen_flow", section: "fixed:3.1.1", owner_kind: null, owner_id: null,
      puml: "@startuml\n@enduml\n", render_status: "ok", source_hash: "hash-truoc-khi-doi-quyen", rendered_at: "2026-01-01T00:00:00.000Z"
    })
    const { events, emit } = collectEvents()
    await runStep(PROJECT, "S-8.3", SESSION, USER, emit, { assembleDocument: vi.fn(async () => undefined), renderDeps: renderStub() })

    const renders = events.filter((e) => e.type === "render")
    expect(renders.length).toBeGreaterThan(0)
    const after = (await repo.get(PROJECT))!
    const { staleDiagrams } = await import("../diagram/diagram.service.js")
    expect(staleDiagrams(after).filter((d) => d.kind === "screen_flow")).toEqual([])
    expect(after.diagrams.some((d) => d.id === "D90" || d.id.startsWith("D90-"))).toBe(true)

    // Hình không cũ ⇒ không vẽ lại
    db.reset()
    seedUpTo("S-8.3")
    seedSession(true)
    const fresh = db.spines[0] as unknown as SpineT
    const { computeSourceHash } = await import("../spine/source-hash.js")
    fresh.diagrams = fresh.diagrams.filter((d) => d.kind !== "screen_flow")
    fresh.diagrams.push({
      id: "D90", kind: "screen_flow", section: "fixed:3.1.1", owner_kind: null, owner_id: null,
      puml: "@startuml\n@enduml\n", render_status: "ok", source_hash: computeSourceHash(fresh, { kind: "screen_flow", owner_id: null }), rendered_at: "2026-01-01T00:00:00.000Z"
    })
    const again = collectEvents()
    await runStep(PROJECT, "S-8.3", SESSION, USER, again.emit, { assembleDocument: vi.fn(async () => undefined), renderDeps: renderStub() })
    expect(again.events.some((e) => e.type === "gate_ready")).toBe(true)
    expect(again.events.filter((e) => e.type === "render")).toEqual([])
  })

  it("step tất định khác (S-8.3) không ghép", async () => {
    seedUpTo("S-8.3")
    seedSession(true)
    const assembleDocument = vi.fn(async () => undefined)
    const { emit } = collectEvents()

    await runStep(PROJECT, "S-8.3", SESSION, USER, emit, { assembleDocument, renderDeps: renderStub() })
    expect(assembleDocument).not.toHaveBeenCalled()
  })
})

describe("step-runner: lượt chờ trả lời sống qua reload / rớt kết nối (FLF-222)", () => {
  const askTwo = () =>
    elicitReply("Hỏi", [
      { question: "Actor chính là ai?", options: [], multiple: false, topic_key: "primary_actor" } as never,
      { question: "Ai duyệt yêu cầu?", options: [], multiple: false, topic_key: "approver" } as never
    ])

  const waitFor = async (events: StepEvent[], type: StepEvent["type"]) => {
    for (let i = 0; i < 50 && !events.some((e) => e.type === type); i++) await new Promise((r) => setTimeout(r, 0))
  }

  it("đóng kết nối khi đang chờ ⇒ step không bị huỷ: run-state giữ waiting_answer + pending_answer, khoá đã nhả", async () => {
    seedSpine()
    seedSession(true)
    const controller = new AbortController()
    const draftExecutor = vi.fn(async () => draftReply([]))
    const { events, emit } = collectEvents()
    const run = runStep(PROJECT, "S-3.1", SESSION, USER, emit, {
      elicitExecutor: async () => askTwo(),
      draftExecutor,
      renderDeps: renderStub(),
      signal: controller.signal,
      abort: controller
    })
    await waitFor(events, "answer_needed")

    controller.abort() // reload / đóng tab: không kèm lý do huỷ
    await expect(run).resolves.toBeUndefined()

    const state = await getRunState(PROJECT, "S-3.1")
    expect(state).toMatchObject({ status: "waiting_answer", stage: "ask", error: null })
    expect(state?.questions).toHaveLength(2)
    expect(state?.pending_answer).toMatchObject({ kind: "step", unit: "S-3.1", session_id: SESSION })
    expect(state?.pending_answer?.asked.map((q) => q.topic_key)).toEqual(["primary_actor", "approver"])
    expect(new Date(state!.locked_until).getTime()).toBeLessThanOrEqual(Date.now())
    expect((await repo.get(PROJECT))!.steps.find((s) => s.id === "S-3.1")?.status).toBe("in_progress")
    expect(events.some((e) => e.type === "error" || e.type === "gate_ready")).toBe(false)
    expect(draftExecutor).not.toHaveBeenCalled()
    // Không còn Promise chờ trong bộ nhớ ⇒ lượt sống không nhận câu trả lời nữa, `/answer` phải đi đường run-state
    expect(submitAnswer(PROJECT, "S-3.1", SESSION, { answers: [{ question_id: "Q1", answer: "x" }] })).toBe(false)
  })

  it("đóng kết nối lúc AI đang soạn ⇒ vẫn huỷ như cũ (F8): interrupted, không để lại lượt chờ", async () => {
    seedSpine()
    seedSession(true)
    const controller = new AbortController()
    const draftExecutor = vi.fn(async () => draftReply([]))
    const { emit } = collectEvents()

    // Không hỏi gì ⇒ đi thẳng tới Draft; kết nối đóng ngay sau lượt elicit
    const err = await runStep(PROJECT, "S-3.1", SESSION, USER, emit, {
      elicitExecutor: async () => {
        controller.abort()
        return elicitReply()
      },
      draftExecutor,
      renderDeps: renderStub(),
      signal: controller.signal,
      abort: controller
    }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).code).toBe(STEP_NOT_RUNNABLE)
    expect(draftExecutor).not.toHaveBeenCalled()
    const state = await getRunState(PROJECT, "S-3.1")
    expect(state).toMatchObject({ status: "interrupted", pending_answer: null })
  })
})

describe("step-runner: /answer chạy tiếp lượt chờ đã tách, từ sau Elicit (FLF-222)", () => {
  const askTwo = () =>
    elicitReply("Hỏi", [
      { question: "Actor chính là ai?", options: [], multiple: false, topic_key: "primary_actor" } as never,
      { question: "Mức uptime mong muốn?", options: [{ label: "99%" }, { label: "99.9%" }], multiple: false, topic_key: "uptime" } as never
    ])
  const addActor = () => draftReply([{ op: "add", path: "actors[]", value: { id: "A09", name: "Quản trị viên", kind: "human", description: "d" } }])

  /** Chạy S-3.1 tới lúc hỏi; `leave` giả lập cách kết nối mất: reload (abort) hoặc BE restart (mất bộ nhớ). */
  const runUntilAsked = async (leave: "reload" | "restart") => {
    const controller = new AbortController()
    const elicitExecutor = vi.fn(async () => askTwo())
    const draftExecutor = vi.fn<StepRunnerDeps["draftExecutor"]>(async () => addActor())
    const { events, emit } = collectEvents()
    const run = runStep(PROJECT, "S-3.1", SESSION, USER, emit, { elicitExecutor, draftExecutor, renderDeps: renderStub(), signal: controller.signal, abort: controller })
    for (let i = 0; i < 50 && !events.some((e) => e.type === "answer_needed"); i++) await new Promise((r) => setTimeout(r, 0))
    if (leave === "reload") {
      controller.abort()
      await run
    } else {
      dropPendingAnswers() // tiến trình chết: Promise chờ biến mất, run-state ở DB còn nguyên
    }
    return { elicitExecutor, draftExecutor }
  }

  const answerAndFinish = async (draftExecutor: StepRunnerDeps["draftExecutor"]) => {
    const answers = [
      { question_id: "Q1", answer: "Quản trị viên" },
      { question_id: "Q2", answer: "99.9%" }
    ]
    expect(submitAnswer(PROJECT, "S-3.1", SESSION, { answers }), "không còn lượt đang nghe").toBe(false)
    const pending = await pendingAnswerFor(PROJECT, "S-3.1", SESSION, { answers })
    const { done } = await resumeWaitingStep(PROJECT, "S-3.1", USER, pending, { answers }, { draftExecutor, renderDeps: renderStub() })
    // `/answer` trả ngay: lượt nền đang giữ khoá
    expect((await getRunState(PROJECT, "S-3.1"))?.status).toBe("running")
    await done
  }

  it.each(["reload", "restart"] as const)("%s giữa lúc chờ ⇒ trả lời được, tới gate, không gọi elicit lần 2", async (leave) => {
    seedSpine()
    seedSession(true)
    const { elicitExecutor, draftExecutor } = await runUntilAsked(leave)

    await answerAndFinish(draftExecutor)

    const state = await getRunState(PROJECT, "S-3.1")
    expect(state).toMatchObject({ status: "gate", stage: "gate", pending_answer: null, questions: null, error: null })
    expect(state?.gate_payload).toMatchObject({ type: "gate_ready", step_id: "S-3.1", wrote_ops: true })
    const kinds = (state?.events as StepEvent[]).map((e) => e.type)
    expect(kinds).toContain("answer_received")
    expect(kinds).toContain("ops_applied")

    expect(elicitExecutor).toHaveBeenCalledTimes(1)
    expect(db.usages.filter((u) => u.call_kind === "elicit")).toHaveLength(1)
    // Lượt soạn thấy đủ câu hỏi + câu trả lời
    const draftInput = draftExecutor.mock.calls[0]![1] as { promptVariables: Record<string, unknown> }
    expect(JSON.stringify(draftInput.promptVariables)).toContain("Actor chính là ai? → Quản trị viên")

    const spine = (await repo.get(PROJECT))!
    expect(spine.actors.map((a) => a.id)).toContain("A09")
    expect(spine.decisions.map((d) => d.topic_key)).toContain("uptime")
    const userMsgs = (db.sessions[0].messages as { role: string; content: string }[]).filter((m) => m.role === "user").map((m) => m.content)
    expect(userMsgs).toEqual(["Quản trị viên", "99.9%"])
  })

  it("question_id lạ, session khác, hay step không đang chờ ⇒ 409 STEP_NOT_RUNNABLE, không chạy gì", async () => {
    seedSpine()
    seedSession(true)
    await expect(pendingAnswerFor(PROJECT, "S-3.1", SESSION, { answers: [{ question_id: "Q1", answer: "x" }] })).rejects.toMatchObject({ statusCode: 409, code: STEP_NOT_RUNNABLE })

    await runUntilAsked("reload")
    await expect(pendingAnswerFor(PROJECT, "S-3.1", SESSION, { answers: [{ question_id: "Q9", answer: "x" }] })).rejects.toMatchObject({ code: STEP_NOT_RUNNABLE })
    await expect(pendingAnswerFor(PROJECT, "S-3.1", "sess-khac", { answers: [{ question_id: "Q1", answer: "x" }] })).rejects.toMatchObject({ code: STEP_NOT_RUNNABLE })
    await expect(pendingAnswerFor(PROJECT, "S-3.1", SESSION, { answers: [] })).rejects.toMatchObject({ code: STEP_NOT_RUNNABLE })
    expect((await getRunState(PROJECT, "S-3.1"))?.status).toBe("waiting_answer")
  })

  it("hai /answer cùng lúc ⇒ chỉ một lượt chạy tiếp, lượt sau 409", async () => {
    seedSpine()
    seedSession(true)
    const { draftExecutor } = await runUntilAsked("reload")
    const answers = [{ question_id: "Q1", answer: "Quản trị viên" }]
    const pending = await pendingAnswerFor(PROJECT, "S-3.1", SESSION, { answers })

    const first = await resumeWaitingStep(PROJECT, "S-3.1", USER, pending, { answers }, { draftExecutor, renderDeps: renderStub() })
    await expect(resumeWaitingStep(PROJECT, "S-3.1", USER, pending, { answers }, { draftExecutor, renderDeps: renderStub() })).rejects.toMatchObject({ code: STEP_NOT_RUNNABLE })
    await first.done
    expect(draftExecutor).toHaveBeenCalledTimes(1)
  })

  it("lượt nền lỗi ⇒ run-state interrupted kèm lỗi, không ném ra ngoài request", async () => {
    seedSpine()
    seedSession(true)
    await runUntilAsked("reload")
    const answers = [{ question_id: "Q1", answer: "Quản trị viên" }]
    const pending = await pendingAnswerFor(PROJECT, "S-3.1", SESSION, { answers })
    const failing = vi.fn(async () => {
      throw new ApiError(502, "provider chết", "AI_PROVIDER_ERROR")
    })

    const { done } = await resumeWaitingStep(PROJECT, "S-3.1", USER, pending, { answers }, { draftExecutor: failing, renderDeps: renderStub() })
    await expect(done).resolves.toBeUndefined()
    expect(await getRunState(PROJECT, "S-3.1")).toMatchObject({ status: "interrupted", error: { code: "AI_PROVIDER_ERROR" } })
  })
})

describe("resume sau khi step chết giữa chừng / đang chờ trả lời (FLF-222)", () => {
  const addActor = (id: string) => draftReply([{ op: "add", path: "actors[]", value: { id, name: `Actor ${id}`, kind: "human", description: "d" } }])
  const actorIds = async () => (await repo.get(PROJECT))!.actors.map((a) => a.id)

  /** Lượt chạy lại ghi xong nội dung rồi chết (mất kết nối / tiến trình) TRƯỚC khi kịp ghi dải seq của vòng. */
  const runRoundThatDies = (deps: Partial<StepRunnerDeps>) => {
    vi.mocked(applyTransaction).mockImplementation(async (projectId, txn) => {
      if (txn.reason === "step-runner: cập nhật dải seq") throw new Error("tiến trình chết giữa chừng")
      return actualApplyTransaction(projectId, txn)
    })
    return runStep(PROJECT, "S-3.1", SESSION, USER, collectEvents().emit, deps)
      .catch((e: unknown) => e)
      .finally(() => vi.mocked(applyTransaction).mockImplementation(actualApplyTransaction))
  }

  it("tới gate rồi chạy lại step, lượt mới chết lúc soạn ⇒ /resume revert sạch cả hai lượt (trước: 422 revert_conflict ở elicit_turns)", async () => {
    seedSpine()
    seedSession(true)
    await runStep(PROJECT, "S-3.1", SESSION, USER, collectEvents().emit, { elicitExecutor: async () => elicitReply(), draftExecutor: async () => addActor("A09"), renderDeps: renderStub() })
    // Lượt 2 ghi thêm nội dung rồi mất kết nối trước khi tới gate: phần nó ghi nằm SAU last_seq của lượt 1
    let drafted = 0
    const err = await runRoundThatDies({
      elicitExecutor: async () => elicitReply(),
      draftExecutor: async () => {
        drafted++
        return addActor("A10")
      },
      renderDeps: renderStub()
    })
    expect(err).toBeInstanceOf(Error)
    expect(drafted).toBe(1)
    expect(await actorIds()).toEqual(expect.arrayContaining(["A09", "A10"]))

    const result = await resumeProject(PROJECT, USER)

    expect(result.reverted_step).toBe("S-3.1")
    expect(await actorIds()).toEqual(["A01"])
    expect((await repo.get(PROJECT))!.steps.find((s) => s.id === "S-3.1")).toMatchObject({ status: "pending", first_seq: null, last_seq: null })
  })

  it("gate revision nới dải qua cờ recompute + sổ sách ⇒ /resume revert sạch (trước: 422 CHANGE_RANGE_INVALID)", async () => {
    seedSpine()
    seedSession(true)
    const deps = { elicitExecutor: async () => elicitReply(), draftExecutor: async () => addActor("A09"), renderDeps: renderStub() }
    await runStep(PROJECT, "S-3.1", SESSION, USER, collectEvents().emit, deps)
    await gate(PROJECT, "S-3.1", USER, { action: "revision", note: "thêm actor", base_version: (await repo.get(PROJECT))!.spine_version }, { ...deps, draftExecutor: async () => addActor("A10") })
    expect(db.changes.some((c) => c.step_id === null && String(c.path).startsWith("flags["))).toBe(true)

    const result = await resumeProject(PROJECT, USER)

    expect(result.reverted_step).toBe("S-3.1")
    expect(await actorIds()).toEqual(["A01"])
  })

  it("user sửa tay nội dung xen giữa lượt chạy lại ⇒ vẫn 422 CHANGE_RANGE_INVALID, không revert (F13)", async () => {
    seedSpine()
    seedSession(true)
    await runStep(PROJECT, "S-3.1", SESSION, USER, collectEvents().emit, { elicitExecutor: async () => elicitReply(), draftExecutor: async () => addActor("A09"), renderDeps: renderStub() })
    const current = (await repo.get(PROJECT))!
    await applyTransaction(PROJECT, { base_version: current.spine_version, ops: [{ op: "add", path: "actors[]", value: { id: "A77", name: "Sửa tay", kind: "human", description: "ngoài step" } }], by: USER, step_id: null, reason: "user /changes" })
    await runRoundThatDies({ elicitExecutor: async () => elicitReply(), draftExecutor: async () => addActor("A10"), renderDeps: renderStub() })

    const err = await resumeProject(PROJECT, USER).catch((e: unknown) => e)
    expect(err).toMatchObject({ statusCode: 422, code: "CHANGE_RANGE_INVALID" })
    expect(await actorIds()).toEqual(expect.arrayContaining(["A09", "A10", "A77"]))
  })

  it("step đang chờ trả lời (đã tách) ⇒ /resume không revert, /answer sau đó vẫn chạy tiếp tới gate", async () => {
    seedSpine()
    seedSession(true)
    // Lượt 1 tới gate để step có dải seq — đúng cảnh reload của ticket: chạy lại, hỏi, rồi F5
    await runStep(PROJECT, "S-3.1", SESSION, USER, collectEvents().emit, { elicitExecutor: async () => elicitReply(), draftExecutor: async () => addActor("A09"), renderDeps: renderStub() })
    const controller = new AbortController()
    const { events, emit } = collectEvents()
    const run = runStep(PROJECT, "S-3.1", SESSION, USER, emit, {
      elicitExecutor: async () => elicitReply("Hỏi", [{ question: "Thêm actor nào?", options: [], multiple: false, topic_key: "extra_actor" } as never]),
      draftExecutor: async () => addActor("A10"),
      renderDeps: renderStub(),
      signal: controller.signal,
      abort: controller
    })
    for (let i = 0; i < 50 && !events.some((e) => e.type === "answer_needed"); i++) await new Promise((r) => setTimeout(r, 0))
    controller.abort()
    await run

    const result = await resumeProject(PROJECT, USER)
    expect(result.reverted_step).toBeNull()
    expect(await actorIds()).toContain("A09")
    expect((await repo.get(PROJECT))!.steps.find((s) => s.id === "S-3.1")?.status).toBe("in_progress")

    const answers = [{ question_id: "Q1", answer: "Kế toán" }]
    const pending = await pendingAnswerFor(PROJECT, "S-3.1", SESSION, { answers })
    const { done } = await resumeWaitingStep(PROJECT, "S-3.1", USER, pending, { answers }, { draftExecutor: async () => addActor("A10"), renderDeps: renderStub() })
    await done
    expect(await getRunState(PROJECT, "S-3.1")).toMatchObject({ status: "gate" })
    expect(await actorIds()).toEqual(expect.arrayContaining(["A09", "A10"]))
  })
})

describe("step-runner: chat tự do khi đang chờ trả lời (FLF-221)", () => {
  const ASK = [
    { question: "Actor chính là ai?", options: [], multiple: false, topic_key: "primary_actor" },
    { question: "Mức uptime mong muốn?", options: [{ label: "99.9% (Khuyến nghị)" }, { label: "99%" }], multiple: false, topic_key: "uptime" }
  ] as never as ElicitOutput["questions"]

  const chatReply = (reply: string, settled: { topic_key: string; answer: string }[]): AiActionResult<ElicitOutput> => ({
    ...elicitReply(reply),
    data: { reply, questions: [], settled }
  })

  const waitCount = async (events: StepEvent[], type: StepEvent["type"], n: number) => {
    for (let i = 0; i < 200 && events.filter((e) => e.type === type).length < n; i++) await new Promise((r) => setTimeout(r, 0))
  }

  /** Chạy S-3.1 tới lượt hỏi đầu; `chat` là lời AI cho mỗi lượt chat tự do theo thứ tự. */
  const start = (chat: AiActionResult<ElicitOutput>[], extra: Partial<StepRunnerDeps> = {}) => {
    const turns = [...chat]
    const chatPrompts: Record<string, unknown>[] = []
    const elicitExecutor = vi.fn(async (input: { promptVariables?: Record<string, unknown> }) => {
      if (input.promptVariables?.chat_turn) {
        chatPrompts.push(input.promptVariables)
        return turns.shift() ?? chatReply("ok", [])
      }
      return elicitReply("Hỏi", ASK)
    })
    const draftExecutor = vi.fn<StepRunnerDeps["draftExecutor"]>(async () => draftReply([]))
    const { events, emit } = collectEvents()
    const run = runStep(PROJECT, "S-3.1", SESSION, USER, emit, { elicitExecutor: elicitExecutor as never, draftExecutor, renderDeps: renderStub(), ...extra })
    return { run, events, elicitExecutor, draftExecutor, chatPrompts }
  }

  const decisionsOf = async () => (await repo.get(PROJECT))!.decisions.filter((d) => d.superseded_by === null)

  it("tin nhắn trả lời 1/2 câu ⇒ 1 decision, hỏi lại đúng câu còn chờ (id ổn định), AI nhắc câu còn chờ", async () => {
    seedSpine()
    seedSession(true)
    const s = start([chatReply("Đã ghi uptime 99%. Còn câu về actor chính nhé.", [{ topic_key: "uptime", answer: "99%" }])])
    await waitCount(s.events, "answer_needed", 1)
    expect(submitAnswer(PROJECT, "S-3.1", SESSION, { answers: [], message: "Uptime 99% là đủ cho tụi mình" })).toBe(true)
    await waitCount(s.events, "answer_needed", 2)

    const again = s.events.filter((e) => e.type === "answer_needed")[1] as Extract<StepEvent, { type: "answer_needed" }>
    expect(again.questions.map((q) => q.id)).toEqual(["Q_primary_actor"])
    expect((await decisionsOf()).map((d) => [d.topic_key, d.answer])).toEqual([["uptime", "99%"]])
    expect(s.events.some((e) => e.type === "elicit" && e.delta.includes("Còn câu về actor"))).toBe(true)
    // Lượt chat thấy câu đang chờ và tin nhắn của user
    expect(s.chatPrompts[0]).toMatchObject({ user_message: "Uptime 99% là đủ cho tụi mình" })
    expect(JSON.stringify(s.chatPrompts[0].pending_questions)).toContain("Q_uptime")

    submitAnswer(PROJECT, "S-3.1", SESSION, { answers: [{ question_id: "Q_primary_actor", answer: "Quản trị viên" }] })
    await s.run
    expect(s.events.some((e) => e.type === "gate_ready")).toBe(true)
    const userMsgs = (db.sessions[0].messages as { role: string; content: string }[]).filter((m) => m.role === "user").map((m) => m.content)
    expect(userMsgs).toEqual(["Uptime 99% là đủ cho tụi mình", "Quản trị viên"])
  })

  it("tin nhắn lạc đề ⇒ 0 decision, vẫn chờ đủ 2 câu", async () => {
    seedSpine()
    seedSession(true)
    const s = start([chatReply("Câu hỏi hay! Nhưng mình vẫn cần biết actor chính và uptime.", [])])
    await waitCount(s.events, "answer_needed", 1)
    submitAnswer(PROJECT, "S-3.1", SESSION, { answers: [], message: "Phần mềm này có chạy trên iPad không?" })
    await waitCount(s.events, "answer_needed", 2)
    const again = s.events.filter((e) => e.type === "answer_needed")[1] as Extract<StepEvent, { type: "answer_needed" }>
    expect(again.questions).toHaveLength(2)
    expect(await decisionsOf()).toEqual([])
    submitAnswer(PROJECT, "S-3.1", SESSION, { answers: [{ question_id: "Q_primary_actor", answer: "Lễ tân" }, { question_id: "Q_uptime", answer: "99%" }] })
    await s.run
  })

  it("settled không khớp nhãn option ⇒ bỏ; câu mở ghi nguyên văn tin user, không lấy câu model diễn lại", async () => {
    seedSpine()
    seedSession(true)
    const s = start([
      chatReply("Ghi nhận.", [
        { topic_key: "uptime", answer: "99.5%" },
        { topic_key: "primary_actor", answer: "Receptionist (model paraphrase)" },
        { topic_key: "not_asked", answer: "x" }
      ])
    ])
    await waitCount(s.events, "answer_needed", 1)
    submitAnswer(PROJECT, "S-3.1", SESSION, { answers: [], message: "Người dùng chính là lễ tân" })
    await waitCount(s.events, "answer_needed", 2)
    expect((await decisionsOf()).map((d) => [d.topic_key, d.answer])).toEqual([["primary_actor", "Người dùng chính là lễ tân"]])
    const again = s.events.filter((e) => e.type === "answer_needed")[1] as Extract<StepEvent, { type: "answer_needed" }>
    expect(again.questions.map((q) => q.id)).toEqual(["Q_uptime"])
    submitAnswer(PROJECT, "S-3.1", SESSION, { answers: [{ question_id: "Q_uptime", answer: "99.9% (Khuyến nghị)" }] })
    await s.run
  })

  it("ngân sách sát trần ⇒ không gọi thêm lượt chat, đi thẳng tới lượt soạn, không lỗi CALL_LIMIT", async () => {
    seedSpine()
    seedSession(true)
    let seeded = false
    const s = start([], {
      elicitExecutor: (async (input: { promptVariables?: Record<string, unknown> }) => {
        if (input.promptVariables?.chat_turn) throw new Error("không được gọi lượt chat khi hết ngân sách")
        if (!seeded) {
          seeded = true
          // Ba lượt đã tiêu trong vòng này ⇒ còn 8 - 4 = 4 < 1 + draft (3) + review (1)
          for (let i = 0; i < 3; i++) {
            db.usages.push({ _id: `burn${i}`, projectId: PROJECT, userId: USER, step_id: "S-3.1", call_kind: "draft", attempt: 1, tokens_in: 1, tokens_out: 1, cost: 1, state: "deducted", expires_at: "2099-01-01T00:00:00.000Z", logId: null, createdAt: new Date().toISOString() })
          }
        }
        return elicitReply("Hỏi", ASK)
      }) as never
    })
    await waitCount(s.events, "answer_needed", 1)
    submitAnswer(PROJECT, "S-3.1", SESSION, { answers: [], message: "Tuỳ bạn quyết" })
    await s.run
    expect(s.events.some((e) => e.type === "gate_ready")).toBe(true)
    expect(s.events.some((e) => e.type === "elicit" && e.delta === CHAT_BUDGET_REPLY)).toBe(true)
    const draftInput = s.draftExecutor.mock.calls[0]![1] as { promptVariables: Record<string, unknown> }
    expect(JSON.stringify(draftInput.promptVariables)).toContain("tự giả định")
  })

  it("sau reload: /answer chỉ có message ⇒ chạy lượt chat (không nhảy thẳng tới lượt soạn), hỏi lại câu còn chờ", async () => {
    seedSpine()
    seedSession(true)
    const controller = new AbortController()
    const s = start([], { signal: controller.signal, abort: controller })
    await waitCount(s.events, "answer_needed", 1)
    controller.abort()
    await s.run

    const payload = { answers: [], message: "Uptime 99% nhé" }
    expect(submitAnswer(PROJECT, "S-3.1", SESSION, payload)).toBe(false)
    const pending = await pendingAnswerFor(PROJECT, "S-3.1", SESSION, payload)
    const elicitExecutor = vi.fn(async () => chatReply("Đã ghi 99%.", [{ topic_key: "uptime", answer: "99%" }]))
    const draftExecutor = vi.fn<StepRunnerDeps["draftExecutor"]>(async () => draftReply([]))
    await resumeWaitingStep(PROJECT, "S-3.1", USER, pending, payload, { elicitExecutor: elicitExecutor as never, draftExecutor, renderDeps: renderStub() })
    for (let i = 0; i < 200 && (await getRunState(PROJECT, "S-3.1"))?.status !== "waiting_answer"; i++) await new Promise((r) => setTimeout(r, 0))

    expect(elicitExecutor).toHaveBeenCalledTimes(1)
    expect(draftExecutor).not.toHaveBeenCalled()
    const state = await getRunState(PROJECT, "S-3.1")
    expect(state).toMatchObject({ status: "waiting_answer" })
    expect((state?.questions as { id: string }[]).map((q) => q.id)).toEqual(["Q_primary_actor"])
    expect(state?.pending_answer?.asked.map((q) => q.topic_key)).toEqual(["primary_actor"])
    dropPendingAnswers() // lượt nền đang chờ câu còn lại — dọn như tiến trình kết thúc
  })

  it("/answer thiếu cả answers lẫn message ⇒ không nhận", async () => {
    seedSpine()
    seedSession(true)
    const controller = new AbortController()
    const s = start([], { signal: controller.signal, abort: controller })
    await waitCount(s.events, "answer_needed", 1)
    controller.abort()
    await s.run
    await expect(pendingAnswerFor(PROJECT, "S-3.1", SESSION, { answers: [] })).rejects.toMatchObject({ code: STEP_NOT_RUNNABLE })
  })
})
