/**
 * s2-s3.e2e.test.ts
 * ─────────────────────────────────────────────────────────────────
 * T14: proves the content skills for S-1.2, S-2.1…S-2.5, S-3.1…S-3.6 run end to end on
 * `spine-fixture-minimal.json` (only `project{}` + `addendum[]`) via `step-runner.service` (T13)
 * `runStep` + `gate.service` accept — the same public, non-HTTP entry point T13 documents for T14/T16.
 *
 * Mock provider (default): `draftExecutor`/`elicitExecutor` return canned ops read from
 * `fixtures/op-cases/s2-s3/<step_id>.json` instead of calling a model — same in-memory Mongo mock
 * pattern as `step-runner.test.ts` (T13), reused here rather than duplicated logic.
 *
 * `E2E_AI=1` (real provider, real credit ledger, real DB): NOT run tonight — no API key, no Mongo,
 * no wallet seeded in this harness. Skipped with `it.skipIf`, reason in the test name itself.
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

  const reset = () => {
    spines.length = 0
    changes.length = 0
    usages.length = 0
    sessions.length = 0
    usageSeq = 0
  }
  return { Spine, Change, Usage, ChatSession, spines, changes, usages, sessions, reset }
})

vi.mock("../../spine/spine.model.js", () => ({ Spine: db.Spine }))
vi.mock("../../spine/change.model.js", () => ({ Change: db.Change }))
vi.mock("../../spine/usage.model.js", () => ({ Usage: db.Usage }))
vi.mock("../../project/chat-session.model.js", () => ({ ChatSession: db.ChatSession }))
vi.mock("../../../shared/ai/document-context.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../shared/ai/document-context.service.js")>()
  return { ...actual, buildDocumentContext: vi.fn(async () => ({ contextText: "", tokenCount: 0, documentsUsed: 0, usedSummary: false })) }
})
vi.mock("../../notification/notification.service.js", () => ({ notify: vi.fn(async () => null), notifyAdmins: vi.fn(async () => 0) }))

import { spineSchema } from "../../spine/spine.schema.js"
import type { Spine as SpineT } from "../../spine/spine.types.js"
import * as repo from "../../spine/spine.repository.js"
import { createMemoryDiagramStore } from "../../diagram/diagram-file.store.js"
import type { DiagramServiceDeps } from "../../diagram/diagram.service.js"
import type { CompileCheckResult } from "../../../shared/diagram/compile-check.js"
import { orderedSteps } from "../step-registry.js"
import type { AiActionResult } from "../../../shared/ai/ai-action.types.js"
import type { OpTransaction, ElicitOutput } from "../../../shared/ai/response-parser.js"
import { runStep, type StepRunnerDeps, defaultStepRunnerDeps } from "../step-runner.service.js"
import { gate } from "../gate.service.js"
import { stepEventSchema, type StepEvent } from "../pipeline.dto.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.resolve(__dirname, "../../../../fixtures")
const OP_CASES_DIR = path.join(FIXTURES, "op-cases", "s2-s3")
const readJson = (...s: string[]): unknown => JSON.parse(fs.readFileSync(path.join(FIXTURES, ...s), "utf8"))
const MINIMAL: SpineT = spineSchema.parse(readJson("spine-fixture-minimal.json"))

const PROJECT = "650000000000000000000002"
const USER = "650000000000000000000011"
const SESSION = "sess-t14"

/** The 12 steps this task proves: S-2.5/S-3.6 are render-only (no skill), the rest draft through the mock. */
const STEPS_UNDER_TEST = ["S-1.2", "S-2.1", "S-2.2", "S-2.3", "S-2.4", "S-2.5", "S-3.1", "S-3.2", "S-3.3", "S-3.4", "S-3.5", "S-3.6"] as const

interface OpCaseFile {
  step_id: string
  skill_id?: string
  notes?: string
  ops: OpTransaction["ops"]
}

const loadOpCase = (stepId: string): OpCaseFile =>
  JSON.parse(fs.readFileSync(path.join(OP_CASES_DIR, `${stepId.toLowerCase()}.json`), "utf8")) as OpCaseFile

/**
 * Every registry step up to and including S-3.6 that is NOT one of `STEPS_UNDER_TEST`, marked accepted:
 * B-0…B-2, S-1.1, S-1.3, S-1.4 (out of T14 scope — Brief/intake steps a different task owns) so that
 * `nextStep()` lands exactly on S-1.2 first and then walks the 12 target steps in order. Mirrors
 * `stepsBeforeS3` in step-runner.test.ts, generalized to skip a target set instead of a single prefix.
 */
const stepsBeforeTarget = () => {
  const all = orderedSteps({ screens: [], functions: [] })
  const target = new Set<string>(STEPS_UNDER_TEST)
  const lastIdx = all.findIndex((s) => s.id === "S-3.6")
  return all
    .slice(0, lastIdx + 1)
    .filter((s) => !target.has(s.id))
    .map((s) => ({ id: s.id, status: "accepted" as const, first_seq: 1, last_seq: 1, accepted_at: "2026-01-01T00:00:00.000Z" }))
}

const seedSpine = () => {
  const spine = structuredClone(MINIMAL)
  spine.progress.current_phase = "S-1"
  spine.progress.current_step = "S-1.2"
  spine.steps = stepsBeforeTarget()
  db.spines[0] = { _id: "spine", projectId: PROJECT, ...spine }
}

const seedSession = (isPipeline: boolean) => {
  db.sessions.push({ _id: SESSION, projectId: PROJECT, messages: [], isActive: true, is_pipeline: isPipeline })
}

const renderStub = (): Partial<DiagramServiceDeps> => {
  const store = createMemoryDiagramStore()
  const check: DiagramServiceDeps["check"] = async () =>
    ({ ok: true, method: "svg-scan", render: { format: "svg", data: Buffer.from("<svg/>"), contentType: "image/svg+xml", transport: "post", status: 200, diagnostics: {} } }) as CompileCheckResult
  return { check, renderPng: async () => Buffer.from("png"), store, now: () => new Date("2026-09-15T02:00:00.000Z") }
}

const collectEvents = () => {
  const events: StepEvent[] = []
  const emit = (e: StepEvent) => {
    events.push(stepEventSchema.parse(e))
  }
  return { events, emit }
}

/** Character-count/4 estimate (same heuristic as `context-projection.ts#estimateTokens`) — used only because
 *  the mock provider has no real token count. Real numbers are recorded once `E2E_AI=1` runs (`docs/measurements.md`). */
const estimateTokens = (text: string): number => Math.max(1, Math.ceil(text.length / 4))
/** Rough mock credit unit, NOT the real pricing table (`meter.service.ts`) — documented as an estimate. */
const estimateCost = (tokensIn: number, tokensOut: number): number => Number(((tokensIn + tokensOut) * 0.000002).toFixed(6))

export interface MeasuredUsage {
  step_id: string
  call_kind: "elicit" | "draft"
  tokens_in: number
  tokens_out: number
  cost: number
}

/** Populated while the mock executors run — read at the end of the test for `docs/measurements.md`. */
const measuredUsage: MeasuredUsage[] = []

const elicitExecutor: StepRunnerDeps["elicitExecutor"] = async (input) => {
  const stepId = (input.promptVariables as { step_id: string }).step_id
  const promptText = JSON.stringify(input.promptVariables)
  const tokensIn = estimateTokens(promptText)
  const tokensOut = estimateTokens("ok")
  const cost = estimateCost(tokensIn, tokensOut)
  measuredUsage.push({ step_id: stepId, call_kind: "elicit", tokens_in: tokensIn, tokens_out: tokensOut, cost })

  const result: AiActionResult<ElicitOutput> = {
    success: true,
    data: { reply: "ok", questions: [] },
    rawText: "{}",
    actionType: "elicit" as never,
    provider: "mock",
    aiModel: "mock",
    tokensUsed: { promptTokens: tokensIn, completionTokens: tokensOut, totalTokens: tokensIn + tokensOut },
    latencyMs: 1,
    logId: `elicit-${stepId}`,
    cost
  }
  return result
}

const draftExecutor: StepRunnerDeps["draftExecutor"] = async (actionType, input) => {
  const stepId = (input.promptVariables as { step_id: string }).step_id
  const opCase = loadOpCase(stepId)
  const promptText = JSON.stringify(input.promptVariables)
  const completionText = JSON.stringify({ ops: opCase.ops, notes: opCase.notes })
  const tokensIn = estimateTokens(promptText)
  const tokensOut = estimateTokens(completionText)
  const cost = estimateCost(tokensIn, tokensOut)
  measuredUsage.push({ step_id: stepId, call_kind: "draft", tokens_in: tokensIn, tokens_out: tokensOut, cost })

  const result: AiActionResult<OpTransaction> = {
    success: true,
    data: { ops: opCase.ops, ...(opCase.notes ? { notes: opCase.notes } : {}) },
    rawText: "{}",
    actionType: actionType as never,
    provider: "mock",
    aiModel: "mock",
    tokensUsed: { promptTokens: tokensIn, completionTokens: tokensOut, totalTokens: tokensIn + tokensOut },
    latencyMs: 1,
    logId: `draft-${stepId}`,
    cost
  }
  return result
}

beforeEach(() => {
  db.reset()
  measuredUsage.length = 0
})

describe("T14: S-1.2 -> S-3.6 content skills end to end on spine-fixture-minimal (mock provider)", () => {
  it("runs every step through runStep + gate accept; actors/use_cases populated, 0 red flags in fixed:1/2.1/2.2.1/2.2.2, non_english_content = 0, usecase diagram render_status = ok", async () => {
    seedSpine()
    seedSession(true)
    const deps: Partial<StepRunnerDeps> = { draftExecutor, elicitExecutor, renderDeps: renderStub() }

    for (const stepId of STEPS_UNDER_TEST) {
      const { events, emit } = collectEvents()
      await runStep(PROJECT, stepId, SESSION, USER, emit, deps)
      expect(events.some((e) => e.type === "gate_ready"), `${stepId} must reach gate_ready`).toBe(true)

      const record = await repo.get(PROJECT)
      const gateResult = await gate(PROJECT, stepId, USER, { action: "accept", base_version: record!.spine_version })
      expect(gateResult.step.status, `${stepId} must be accepted`).toBe("accepted")
    }

    const final = await repo.get(PROJECT)
    expect(final).toBeTruthy()

    // Actor/use-case minimums (DoD): >= 5 actors mixing human/system/time, >= 12 use cases.
    expect(final!.actors.length).toBeGreaterThanOrEqual(5)
    expect(final!.actors.some((a) => a.kind === "human")).toBe(true)
    expect(final!.actors.some((a) => a.kind === "system")).toBe(true)
    expect(final!.actors.some((a) => a.kind === "time")).toBe(true)
    expect(final!.roles.length).toBeGreaterThan(0)
    expect(final!.roles.every((r) => r.actor_id === null || final!.actors.some((a) => a.id === r.actor_id))).toBe(true)

    expect(final!.use_cases.length).toBeGreaterThanOrEqual(12)
    expect(final!.use_cases.every((u) => u.actor_ids.length > 0)).toBe(true)
    expect(final!.use_cases.some((u) => u.includes.length > 0)).toBe(true)
    expect(final!.use_cases.some((u) => u.extends.length > 0)).toBe(true)

    expect(final!.business_rules.filter((b) => b.tier === "high").length).toBeGreaterThan(0)

    // 0 red flags in the sections this task owns (fixed:1 Product Overview, fixed:2.1 Actors,
    // fixed:2.2.1 Use Case Diagram, fixed:2.2.2 Use Case Descriptions). Reds outside this scope
    // (screens/features/functions — S-4 onward) are expected and out of T14's scope.
    const inScopeSections = new Set(["fixed:1", "fixed:2.1", "fixed:2.2.1", "fixed:2.2.2"])
    const openRedInScope = final!.flags.filter((f) => f.level === "red" && f.resolved_at === null && inScopeSections.has(f.section_id))
    expect(openRedInScope, `unexpected red flags: ${JSON.stringify(openRedInScope)}`).toEqual([])

    const openNonEnglish = final!.flags.filter((f) => f.rule_id === "non_english_content" && f.resolved_at === null)
    expect(openNonEnglish, `non_english_content flags: ${JSON.stringify(openNonEnglish)}`).toEqual([])

    const usecaseDiagram = final!.diagrams.find((d) => d.kind === "usecase")
    expect(usecaseDiagram?.render_status).toBe("ok")
    const contextDiagram = final!.diagrams.find((d) => d.kind === "context")
    expect(contextDiagram?.render_status).toBe("ok")

    // usage[]: every draft-needing step (all but S-2.5/S-3.6, which have no skill) recorded elicit + draft.
    const draftSteps = STEPS_UNDER_TEST.filter((s) => s !== "S-2.5" && s !== "S-3.6")
    for (const stepId of draftSteps) {
      const stepUsage = db.usages.filter((u) => u.step_id === stepId)
      expect(stepUsage.map((u) => u.call_kind).sort(), `${stepId} usage`).toEqual(["draft", "elicit"])
    }
    expect(db.usages.filter((u) => u.step_id === "S-2.5")).toHaveLength(0)
    expect(db.usages.filter((u) => u.step_id === "S-3.6")).toHaveLength(0)

    // Measured (estimated) usage per step for docs/measurements.md — printed so a real run can be
    // transcribed by hand; not asserted on exact numbers (mock estimate, not real provider pricing).
    console.log("[T14 measured usage — mock, char/4 estimate]", JSON.stringify(measuredUsage))
  })
})

describe("T14: real provider (E2E_AI=1)", () => {
  // Not run tonight: no API key, no live Mongo/wallet seeded in this harness. When E2E_AI=1 is set in an
  // environment with those available, this exercises the same flow through `defaultStepRunnerDeps()` and
  // only asserts invariants — never exact wording, since a real model's output varies run to run.
  it.skipIf(process.env.E2E_AI !== "1")(
    "S-1.2 -> S-3.6 via real provider: invariants hold, 0 red flags in fixed:1/2.1/2.2.1/2.2.2, >= 5 actors, >= 12 use cases, usecase render_status = ok",
    async () => {
      seedSpine()
      seedSession(true)
      const deps: Partial<StepRunnerDeps> = defaultStepRunnerDeps()

      for (const stepId of STEPS_UNDER_TEST) {
        const { emit } = collectEvents()
        await runStep(PROJECT, stepId, SESSION, USER, emit, deps)
        const record = await repo.get(PROJECT)
        await gate(PROJECT, stepId, USER, { action: "accept", base_version: record!.spine_version })
      }

      const final = await repo.get(PROJECT)
      expect(final!.actors.length).toBeGreaterThanOrEqual(5)
      expect(final!.use_cases.length).toBeGreaterThanOrEqual(12)
      const inScopeSections = new Set(["fixed:1", "fixed:2.1", "fixed:2.2.1", "fixed:2.2.2"])
      expect(final!.flags.filter((f) => f.level === "red" && f.resolved_at === null && inScopeSections.has(f.section_id))).toEqual([])
      expect(final!.diagrams.find((d) => d.kind === "usecase")?.render_status).toBe("ok")
    }
  )
})
