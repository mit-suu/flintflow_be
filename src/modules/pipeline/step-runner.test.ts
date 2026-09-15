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
    countDocuments: async (filter: Filter) => usages.filter((r) => matches(r, filter)).length
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
import { runStep, submitAnswer, CALL_LIMIT, type StepRunnerDeps } from "./step-runner.service.js"
import { gate } from "./gate.service.js"
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

const collectEvents = () => {
  const events: { type: string; [k: string]: unknown }[] = []
  const emit = (e: { type: string; [k: string]: unknown }) => events.push(e)
  return { events, emit }
}

let actualApplyTransaction: typeof applyTransaction

beforeEach(async () => {
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
    // Step đã in_progress với first_seq=1 (vòng hiện tại) + 8 usage đã deducted cho vòng đó
    db.spines[0].steps = [...(db.spines[0].steps as unknown[]), { id: "S-3.1", status: "in_progress", first_seq: 1, last_seq: 1, accepted_at: null }]
    db.changes.push({ projectId: PROJECT, seq: 1, txn: "t0", op: "set", path: "progress.current_step", before: null, value: "S-3.1", reason: null, at: "2026-01-01T00:00:00.000Z", by: "system", step_id: "S-3.1" })
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
  })
})

describe("step-runner: POST /answer", () => {
  it("submitAnswer resolves lượt chờ answer_needed đang treo; không có lượt chờ ⇒ false", () => {
    expect(submitAnswer(PROJECT, "S-3.1", SESSION, [{ question_id: "Q1", answer: "x" }])).toBe(false)
  })
})
