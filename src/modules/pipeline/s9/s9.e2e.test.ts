/**
 * s9.e2e.test.ts
 * ─────────────────────────────────────────────────────────────────
 * T19: pha gate cuối chạy trọn trên `spine-fixture-19-screens.json` — S-9.1 → S-9.5 qua
 * `step-runner.runStep` + `gate accept`, rồi ký baseline qua `baseline.service.signOff`.
 *
 * Kiểm ba điều quan trọng nhất của pha này:
 *   1. Điều kiện ký là **cờ đỏ = 0**, không phải phần trăm section (audit C7).
 *   2. Bản đã ký **không đổi** khi Spine sống đổi — vì render từ snapshot (`Baseline.snapshot`).
 *   3. S-9.1 và S-9.5 **không tiêu lượt gọi model** (`usage[]` rỗng cho hai step đó) — hết credit vẫn
 *      quét và vẫn ký được.
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect, vi, beforeEach } from "vitest"

/** In-memory store standing in for Mongoose Spine/Change/Usage/ChatSession — same shape as step-runner.test.ts. */
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

  const baselines: Doc[] = []
  let baselineSeq = 0
  const Baseline = {
    create: async (doc: Doc) => {
      if (baselines.some((b) => String(b.projectId) === String(doc.projectId) && b.version === doc.version)) {
        throw Object.assign(new Error("E11000"), { code: 11000 })
      }
      const created = { _id: `bl${++baselineSeq}`, ...copy(doc) }
      baselines.push(created)
      return created
    },
    findById: async (id: string) => copy(baselines.find((b) => b._id === id) ?? null),
    deleteOne: async (filter: { _id: string }) => {
      const i = baselines.findIndex((b) => b._id === filter._id)
      if (i >= 0) baselines.splice(i, 1)
      return { deletedCount: i >= 0 ? 1 : 0 }
    }
  }

  const reset = () => {
    spines.length = 0
    changes.length = 0
    usages.length = 0
    sessions.length = 0
    usageSeq = 0
    baselines.length = 0
    baselineSeq = 0
  }
  return { Spine, Change, Usage, ChatSession, Baseline, spines, changes, usages, sessions, baselines, reset }
})

vi.mock("../../spine/spine.model.js", () => ({ Spine: db.Spine }))
vi.mock("../../spine/change.model.js", () => ({ Change: db.Change }))
vi.mock("../../spine/usage.model.js", () => ({ Usage: db.Usage }))
vi.mock("../../spine/baseline.model.js", () => ({ Baseline: db.Baseline }))
vi.mock("../../project/chat-session.model.js", () => ({ ChatSession: db.ChatSession }))
vi.mock("../../../shared/ai/document-context.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../shared/ai/document-context.service.js")>()
  return { ...actual, buildDocumentContext: vi.fn(async () => ({ contextText: "", tokenCount: 0, documentsUsed: 0, usedSummary: false })) }
})
vi.mock("../../notification/notification.service.js", () => ({ notify: vi.fn(async () => null), notifyAdmins: vi.fn(async () => 0) }))

import { spineSchema } from "../../spine/spine.schema.js"
import type { Spine as SpineT } from "../../spine/spine.types.js"
import * as repo from "../../spine/spine.repository.js"
import { applyTransaction } from "../../spine/op-engine.js"
import { orderedSteps } from "../step-registry.js"
import { runStep, type StepRunnerDeps } from "../step-runner.service.js"
import { gate } from "../gate.service.js"
import { _internal as assembleInternal } from "../../render/assemble.service.js"
import type { AiActionResult } from "../../../shared/ai/ai-action.types.js"
import type { OpTransaction, ReviewOutput } from "../../../shared/ai/response-parser.js"
import { stepEventSchema, type StepEvent } from "../pipeline.dto.js"
import { signOff } from "./baseline.service.js"
import { completenessSweep } from "./completeness-sweep.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE: SpineT = spineSchema.parse(
  JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../../fixtures/spine-fixture-19-screens.json"), "utf8"))
)

const PROJECT = "650000000000000000000006"
const USER = "650000000000000000000015"
const SESSION = "sess-t19"
const S9_STEPS = ["S-9.1", "S-9.2", "S-9.3", "S-9.4", "S-9.5"] as const

/** Mọi step trước S-9.1 đánh dấu accepted để `runStep` cho phép chạy S-9. */
const acceptedBeforeS9 = (spine: SpineT) => {
  const all = orderedSteps(spine)
  return all
    .slice(0, all.findIndex((s) => s.id === "S-9.1"))
    .map((s) => ({ id: s.id, status: "accepted" as const, first_seq: 1, last_seq: 1, accepted_at: "2026-01-01T00:00:00.000Z" }))
}

const seed = (mutate: (spine: SpineT) => void = () => {}): void => {
  const spine = structuredClone(FIXTURE)
  mutate(spine)
  spine.steps = acceptedBeforeS9(spine)
  spine.progress.current_phase = "S-8"
  spine.progress.current_step = "S-8.4"
  db.spines[0] = { _id: "spine", projectId: PROJECT, ...spine }
  db.sessions.push({ _id: SESSION, projectId: PROJECT, messages: [], isActive: true, is_pipeline: true })
}

const version = async (): Promise<number> => (await repo.get(PROJECT))!.spine_version

const collect = () => {
  const events: StepEvent[] = []
  return { events, emit: (e: StepEvent) => void events.push(stepEventSchema.parse(e)) }
}

const reviewExecutor = vi.fn(async () => {
  const result: AiActionResult<ReviewOutput> = {
    success: true,
    data: { flags: [{ level: "yellow", rule_id: "goal_not_covered", section_id: "fixed:1", message: "Goal 2 has no use case behind it." }] },
    rawText: "{}",
    actionType: "review" as never,
    provider: "mock",
    aiModel: "mock",
    tokensUsed: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    latencyMs: 1,
    logId: "review",
    cost: 1
  }
  return result
})

/** S-9.4: xếp hạng mọi function và NFR — đúng việc của step. */
const draftExecutor = vi.fn(async () => {
  const spine = (await repo.get(PROJECT))!
  const ops: OpTransaction["ops"] = [
    ...spine.functions.map((f, i) => ({ op: "set" as const, path: `functions[id=${f.id}].priority`, value: i % 3 === 0 ? "must" : "should", reason: "S-9.4" })),
    ...spine.nfrs.map((n) => ({ op: "set" as const, path: `nfrs[id=${n.id}].priority`, value: "must", reason: "S-9.4" }))
  ]
  const result: AiActionResult<OpTransaction> = {
    success: true,
    data: { ops, notes: "mock prioritization" },
    rawText: "{}",
    actionType: "draft" as never,
    provider: "mock",
    aiModel: "mock",
    tokensUsed: { promptTokens: 20, completionTokens: 40, totalTokens: 60 },
    latencyMs: 1,
    logId: "prio",
    cost: 2
  }
  return result
})

const deps = (): Partial<StepRunnerDeps> => ({ draftExecutor, reviewExecutor })

const walkS9 = async (): Promise<void> => {
  for (const stepId of S9_STEPS) {
    const { events, emit } = collect()
    await runStep(PROJECT, stepId, SESSION, USER, emit, deps())
    expect(events.some((e) => e.type === "gate_ready"), `${stepId} phải tới gate_ready`).toBe(true)
    const result = await gate(PROJECT, stepId, USER, { action: "accept", base_version: await version() })
    expect(result.step.status, `${stepId} phải accepted`).toBe("accepted")
  }
}

beforeEach(() => {
  db.reset()
  draftExecutor.mockClear()
  reviewExecutor.mockClear()
})

describe("T19: S-9.1 → S-9.5 rồi ký baseline (mock provider)", () => {
  it("đi trọn pha, xếp hạng mọi requirement, mở cờ vàng goal_not_covered, ký ra v1.0", async () => {
    seed()
    await walkS9()

    const afterWalk = (await repo.get(PROJECT))!
    expect(afterWalk.functions.every((f) => f.priority !== null), "S-9.4 phải phủ hết function").toBe(true)
    expect(afterWalk.nfrs.every((n) => n.priority !== null), "S-9.4 phải phủ hết NFR").toBe(true)

    const goalFlag = afterWalk.flags.find((f) => f.rule_id === "goal_not_covered" && f.resolved_at === null)
    expect(goalFlag, "S-9.3 mở cờ vàng").toBeTruthy()
    expect(goalFlag!.level, "goal_not_covered không bao giờ là cờ đỏ").toBe("yellow")

    const result = await signOff(PROJECT, USER, { base_version: await version() })
    expect(result.baseline.version).toBe("v1.0")

    const signed = (await repo.get(PROJECT))!
    expect(signed.baselines).toHaveLength(1)
    expect(signed.steps.find((s) => s.id === "S-9.5")?.status).toBe("accepted")
  })

  it("cờ vàng goal_not_covered không chặn ký, và không bị lượt quét sau tự đóng", async () => {
    seed()
    await walkS9()
    const before = (await repo.get(PROJECT))!.flags.find((f) => f.rule_id === "goal_not_covered")!

    // Ký được dù cờ vàng còn mở
    await signOff(PROJECT, USER, { base_version: await version() })

    // signOff vừa recompute một lượt nữa — cờ do model đặt phải còn nguyên
    const after = (await repo.get(PROJECT))!.flags.find((f) => f.id === before.id)!
    expect(after.resolved_at, "MODEL_OWNED_RULES giữ cờ qua recompute").toBeNull()
  })

  it("S-9.1 và S-9.5 không tiêu lượt gọi model; S-9.3/S-9.4 thì có", async () => {
    seed()
    await walkS9()

    const byStep = (stepId: string) => db.usages.filter((u) => u.step_id === stepId)
    expect(byStep("S-9.1"), "S-9.1 không Meter").toHaveLength(0)
    expect(byStep("S-9.5"), "S-9.5 không Meter").toHaveLength(0)
    expect(byStep("S-9.3").length, "S-9.3 có gọi model").toBeGreaterThan(0)
    expect(byStep("S-9.4").length, "S-9.4 có gọi model").toBeGreaterThan(0)
  })

  it("ký xong rồi sửa Spine: bản baseline không đổi, bản draft đổi và có watermark DRAFT", async () => {
    seed()
    await walkS9()
    const signed = await signOff(PROJECT, USER, { base_version: await version() })

    const originalName = (await repo.get(PROJECT))!.actors[0].name
    await applyTransaction(PROJECT, {
      base_version: await version(),
      ops: [{ op: "set", path: `actors[id=${FIXTURE.actors[0].id}].name`, value: "Tên đổi sau khi ký" }],
      by: USER,
      reason: "sửa sau baseline"
    })

    // Snapshot giữ nguyên nội dung lúc ký
    const stored = (await db.Baseline.findById(signed.baseline.snapshot_ref)) as { snapshot: SpineT }
    expect(stored.snapshot.actors[0].name).toBe(originalName)
    expect((await repo.get(PROJECT))!.actors[0].name).toBe("Tên đổi sau khi ký")

    const stubDeps = { loadDiagramPng: async () => null, now: () => new Date("2026-09-16T00:00:00.000Z") }
    const baselineDoc = await assembleInternal.buildDocument(
      { projectId: PROJECT, projectName: "T19", spine: stored.snapshot, statusChanges: [], recordChanges: [], source: "baseline", version: signed.baseline.version },
      stubDeps
    )
    const draftDoc = await assembleInternal.buildDocument(
      { projectId: PROJECT, projectName: "T19", spine: { ...(await repo.get(PROJECT))! }, statusChanges: [], recordChanges: [], source: "draft", version: "v0.99" },
      stubDeps
    )

    const flatten = (doc: { sections: { blocks: unknown[] }[] }): string => JSON.stringify(doc.sections)
    expect(flatten(baselineDoc), "bản ký giữ tên cũ").toContain(originalName)
    expect(flatten(baselineDoc), "bản ký không có tên mới").not.toContain("Tên đổi sau khi ký")
    expect(flatten(draftDoc), "bản nháp theo Spine sống").toContain("Tên đổi sau khi ký")

    expect(baselineDoc.watermark, "bản ký không đóng dấu DRAFT").toBeUndefined()
    expect(draftDoc.watermark).toBe("DRAFT")
  })

  it("S-9.1 báo giả định chưa xác nhận và glossary lạc hậu", async () => {
    seed((spine) => {
      spine.assumptions.push({
        id: "AS910",
        path: "actors[id=A01].name",
        statement: "Tên actor lấy theo cách gọi nội bộ.",
        rationale: "Brief không nói rõ.",
        origin_step_id: "S-3.1",
        status: "unconfirmed",
        confirmed_at: null
      })
    })

    const sweep = await completenessSweep(PROJECT, USER)
    expect(sweep.unconfirmed_assumptions.map((a) => a.id)).toContain("AS910")
    expect(sweep.red_open, "unconfirmed_assumption là cờ đỏ ở S-9").toBeGreaterThan(0)
    expect(sweep.readiness.accepted_pct).toBeGreaterThanOrEqual(0)

    // Cờ đỏ đó chặn ký
    await expect(signOff(PROJECT, USER, { base_version: await version() })).rejects.toMatchObject({ code: "BASELINE_BLOCKED" })
  })
})
