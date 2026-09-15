import { describe, it, expect, vi, beforeEach } from "vitest"

/** Store trong bộ nhớ thay model Mongoose Spine/Change/Usage — cùng ngữ nghĩa step-runner.test.ts. */
const db = vi.hoisted(() => {
  type Doc = Record<string, unknown>
  type Filter = Record<string, unknown>
  const spines: Doc[] = []
  const changes: Doc[] = []
  const usages: Doc[] = []
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
  const reset = () => {
    spines.length = 0
    changes.length = 0
    usages.length = 0
    usageSeq = 0
  }
  return { Spine, Change, Usage, spines, changes, usages, reset }
})

vi.mock("../spine/spine.model.js", () => ({ Spine: db.Spine }))
vi.mock("../spine/change.model.js", () => ({ Change: db.Change }))
vi.mock("../spine/usage.model.js", () => ({ Usage: db.Usage }))
vi.mock("../notification/notification.service.js", () => ({ notify: vi.fn(async () => null), notifyAdmins: vi.fn(async () => 0) }))
vi.mock("../../shared/ai/document-context.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/ai/document-context.service.js")>()
  return { ...actual, buildDocumentContext: vi.fn(async () => ({ contextText: "", tokenCount: 0, documentsUsed: 0, usedSummary: false })) }
})
vi.mock("../project/chat-session.model.js", () => ({ ChatSession: { findById: () => Promise.resolve(null) } }))

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spineSchema } from "../spine/spine.schema.js"
import type { Spine as SpineT } from "../spine/spine.types.js"
import * as repo from "../spine/spine.repository.js"
import { applyTransaction } from "../spine/op-engine.js"
import { orderedSteps } from "./step-registry.js"
import type { StepRunnerDeps } from "./step-runner.service.js"
import type { AiActionResult } from "../../shared/ai/ai-action.types.js"
import type { OpTransaction } from "../../shared/ai/response-parser.js"
import { gate, GateLimitError, REGENERATE_LIMIT, CALL_LIMIT } from "./gate.service.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MINIMAL: SpineT = spineSchema.parse(
  JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/spine-fixture-minimal.json"), "utf8"))
)

const PROJECT = "650000000000000000000001"
const USER = "650000000000000000000010"
const STEP = "S-3.1"

const stepsBeforeS3 = () => {
  const all = orderedSteps({ screens: [], functions: [] })
  const idx = all.findIndex((s) => s.phase === "S-3")
  return all.slice(0, idx).map((s) => ({ id: s.id, status: "accepted" as const, first_seq: 1, last_seq: 1, accepted_at: "2026-01-01T00:00:00.000Z" }))
}

const seedSpine = () => {
  const spine = structuredClone(MINIMAL)
  // Một actor gốc sẵn có — revert (xoá) actor seed thêm sau không vi phạm invariant_2 (mảng rỗng).
  spine.actors = [{ id: "A00", name: "Base actor", kind: "human", description: "sẵn có từ trước" }]
  spine.progress.current_phase = "S-3"
  spine.progress.current_step = "S-3.1"
  spine.steps = stepsBeforeS3()
  db.spines[0] = { _id: "spine", projectId: PROJECT, ...spine }
}

/** Đặt step `in_progress` với một change nội dung THẬT (add actor `actorId`) để regenerate revert được. */
const seedInProgressWithContent = async (stepId: string, actorId: string): Promise<number> => {
  const record = await repo.get(PROJECT)
  const add1 = await applyTransaction(PROJECT, {
    base_version: record!.spine_version,
    ops: [{ op: "add", path: "steps[]", value: { id: stepId, status: "in_progress", first_seq: null, last_seq: null, accepted_at: null } }],
    by: USER,
    step_id: stepId,
    reason: "seed"
  })
  const add2 = await applyTransaction(PROJECT, {
    base_version: add1.spine_version,
    ops: [{ op: "add", path: "actors[]", value: { id: actorId, name: "Seed", kind: "human", description: "x" } }],
    by: USER,
    step_id: stepId,
    reason: "seed content"
  })
  const seq = add2.changes[0].seq
  const add3 = await applyTransaction(PROJECT, {
    base_version: add2.spine_version,
    ops: [
      { op: "set", path: `steps[id=${stepId}].first_seq`, value: seq },
      { op: "set", path: `steps[id=${stepId}].last_seq`, value: seq }
    ],
    by: USER,
    step_id: stepId,
    reason: "seed bookkeeping"
  })
  return add3.spine_version
}

/** `at` mặc định = ngay bây giờ — PHẢI sau `at` thật của change `first_seq` (seed dùng applyTransaction thật). */
const seedUsage = (stepId: string, callKind: string, count: number, at = new Date(Date.now() + 1000).toISOString()) => {
  for (let i = 0; i < count; i++) {
    db.usages.push({
      _id: `pre-${stepId}-${callKind}-${i}`,
      projectId: PROJECT,
      userId: USER,
      step_id: stepId,
      call_kind: callKind,
      attempt: 1,
      tokens_in: 1,
      tokens_out: 1,
      cost: 1,
      state: "deducted",
      expires_at: "2099-01-01T00:00:00.000Z",
      logId: null,
      createdAt: at
    })
  }
}

const draftReply = (ops: OpTransaction["ops"]): AiActionResult<OpTransaction> => ({
  success: true,
  data: { ops },
  rawText: "{}",
  actionType: "regenerate" as never,
  provider: "mock",
  aiModel: "mock",
  tokensUsed: { promptTokens: 50, completionTokens: 20, totalTokens: 70 },
  latencyMs: 1,
  logId: "regen-log",
  cost: 4
})

beforeEach(() => {
  db.reset()
})

describe("gate.service: regenerate — trần 3/step", () => {
  it("lần 4 (regenerate_used=3) ⇒ GateLimitError REGENERATE_LIMIT, không revert/redraft", async () => {
    seedSpine()
    const version = await seedInProgressWithContent(STEP, "A90")
    seedUsage(STEP, "regenerate", 3)

    const draftExecutor = vi.fn()
    const err = await gate(PROJECT, STEP, USER, { action: "regenerate", base_version: version }, { draftExecutor }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(GateLimitError)
    expect((err as GateLimitError).code).toBe(REGENERATE_LIMIT)
    expect((err as GateLimitError).details).toEqual({ regenerate_used: 3 })
    expect(draftExecutor).not.toHaveBeenCalled()
  })

  it("dưới trần: revert dải seq cũ rồi draft lại với ops mới", async () => {
    seedSpine()
    const version = await seedInProgressWithContent(STEP, "A90")

    const deps: Partial<StepRunnerDeps> = {
      draftExecutor: async () => draftReply([{ op: "add", path: "actors[]", value: { id: "A91", name: "Regenerated", kind: "human", description: "y" } }])
    }
    const result = await gate(PROJECT, STEP, USER, { action: "regenerate", base_version: version }, deps)

    expect(result.step.status).toBe("in_progress")
    expect(result.step.regenerate_used).toBe(1)
    const spine = await repo.get(PROJECT)
    expect(spine!.actors.map((a) => a.id)).not.toContain("A90") // bị revert
    expect(spine!.actors.map((a) => a.id)).toContain("A91") // ops mới
  })
})

describe("gate.service: CALL_LIMIT — trần 8/step chặn regenerate/revision, không chặn accept", () => {
  it("calls_used = 8 ⇒ regenerate/revision trả CALL_LIMIT", async () => {
    seedSpine()
    const version = await seedInProgressWithContent(STEP, "A90")
    seedUsage(STEP, "draft", 8)

    const draftExecutor = vi.fn()
    const err = await gate(PROJECT, STEP, USER, { action: "revision", note: "cần sửa lại phần actor cho rõ hơn", base_version: version }, { draftExecutor }).catch(
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(GateLimitError)
    expect((err as GateLimitError).code).toBe(CALL_LIMIT)
    expect(draftExecutor).not.toHaveBeenCalled()
  })

  it("calls_used = 8 vẫn cho accept", async () => {
    seedSpine()
    const version = await seedInProgressWithContent(STEP, "A90")
    seedUsage(STEP, "draft", 8)

    const result = await gate(PROJECT, STEP, USER, { action: "accept", base_version: version })
    expect(result.step.status).toBe("accepted")
  })
})

describe("gate.service: accept_as_is", () => {
  it("ghi cờ vàng accepted_as_is với note, step accepted", async () => {
    seedSpine()
    const version = await seedInProgressWithContent(STEP, "A90")
    seedUsage(STEP, "regenerate", 3)

    const note = "Chấp nhận hiện trạng — actor phụ sẽ bổ sung ở vòng sau theo yêu cầu khách hàng"
    const result = await gate(PROJECT, STEP, USER, { action: "accept_as_is", note, base_version: version })

    expect(result.step.status).toBe("accepted")
    expect(result.step.accepted_at).not.toBeNull()
    const spine = await repo.get(PROJECT)
    const flag = spine!.flags.find((f) => f.rule_id === "accepted_as_is")
    expect(flag).toMatchObject({ level: "yellow", message: note, remediation_step: STEP, waived_by_user: false })
  })
})

describe("gate.service: accept", () => {
  it("step không in_progress/revision_requested ⇒ STEP_NOT_RUNNABLE", async () => {
    seedSpine()
    const record = await repo.get(PROJECT)
    const err = await gate(PROJECT, STEP, USER, { action: "accept", base_version: record!.spine_version }).catch((e: unknown) => e)
    expect(err).toMatchObject({ statusCode: 409, code: "STEP_NOT_RUNNABLE" })
  })

  it("accept step cuối cùng của phase S-2 ⇒ notify phase_accepted (không ném lỗi)", async () => {
    // Mọi step trước S-3 accepted, TRỪ S-2.5 (đặt in_progress ở dưới) — accept S-2.5 xong ⇒ cả phase S-2 accepted.
    const spine = structuredClone(MINIMAL)
    spine.progress.current_phase = "S-2"
    spine.progress.current_step = "S-2.5"
    spine.steps = stepsBeforeS3().filter((s) => s.id !== "S-2.5")
    db.spines[0] = { _id: "spine", projectId: PROJECT, ...spine }

    const version = await seedInProgressWithContent("S-2.5", "A90")
    const result = await gate(PROJECT, "S-2.5", USER, { action: "accept", base_version: version })
    expect(result.step.status).toBe("accepted")
  })
})
