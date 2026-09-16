/**
 * s4-s8.e2e.test.ts
 * ─────────────────────────────────────────────────────────────────
 * T18: proves the content skills for S-4.1…S-4.5, the S-5 loop (per screen and `@nonscreen`),
 * S-6.1…S-6.5, S-7.1…S-7.4 and S-8.1 run end to end through `step-runner.service` (T13) `runStep` +
 * `gate.service` accept — the same public, non-HTTP entry point T13 documents.
 *
 * The starting Spine is `spine-fixture-minimal.json` with the T14 op cases (S-1.2…S-3.5) already
 * applied through the REAL op engine (`planTransaction`, pure, no DB) — so this task starts exactly
 * where T14 finishes instead of hand-copying its output.
 *
 * Mock provider (default): `draftExecutor` reads `fixtures/op-cases/s4-s8/<step>.json`. The two S-5
 * function steps use a TEMPLATE fixture expanded once per function **of the current batch**, read from
 * the projection the runner hands the executor — which is what proves the <= 6 function batching:
 * a 15-function screen produces three calls whose op sets are disjoint.
 *
 * `E2E_AI=1` block (kept from T18, skipped with `it.skipIf`): same shape as `s2-s3.e2e.test.ts` — only the
 * executors become real, but this file runs in the vitest `unit` project (no Mongo) while `executeAiAction`
 * reserves credit through Mongo, so the block cannot run here and is NOT the supported real-provider path.
 * Real-provider runs: `npm run test:e2e-ai` (`test/e2e-ai/**`, in-memory Mongo via `test/setup.ts`) or
 * `npm run measure:tokens -- --mode real-draft|real`. See `docs/spec-gaps.md` (T18, T22, FLF-167).
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
import { planTransaction } from "../../spine/op-engine.js"
import type { Op } from "../../spine/op.types.js"
import { createMemoryDiagramStore } from "../../diagram/diagram-file.store.js"
import type { DiagramServiceDeps } from "../../diagram/diagram.service.js"
import type { CompileCheckResult } from "../../../shared/diagram/compile-check.js"
import { getStep, loadStepRegistry, nextStep, orderedSteps, totalSteps } from "../step-registry.js"
import { STEP_SKILLS } from "../context-projection.js"
import type { AiActionResult } from "../../../shared/ai/ai-action.types.js"
import { opTransactionSchema, type OpTransaction, type ElicitOutput } from "../../../shared/ai/response-parser.js"
import { FUNCTION_BATCH_SIZE, runStep, type StepRunnerDeps, defaultStepRunnerDeps } from "../step-runner.service.js"
import { gate } from "../gate.service.js"
import { getSkill } from "../../../shared/ai/prompt-registry.service.js"
import { stepEventSchema, type StepEvent } from "../pipeline.dto.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.resolve(__dirname, "../../../../fixtures")
const readJson = (...s: string[]): unknown => JSON.parse(fs.readFileSync(path.join(FIXTURES, ...s), "utf8"))
const MINIMAL: SpineT = spineSchema.parse(readJson("spine-fixture-minimal.json"))

const PROJECT = "650000000000000000000003"
const USER = "650000000000000000000012"
const SESSION = "sess-t18"

/** Steps T14 proves; T18 starts from their result. */
const S2_S3_CASES = ["s-1.2", "s-2.1", "s-2.2", "s-2.3", "s-2.4", "s-3.1", "s-3.2", "s-3.3", "s-3.4", "s-3.5"] as const

/** The last step of this task; the walk below stops when `nextStep` reaches it. */
const LAST_STEP = "S-8.1"

interface OpCaseFile {
  step_id: string
  skill_id?: string
  notes?: string
  ops: OpTransaction["ops"]
}

/** Validate the fixture against the real `opTransactionSchema` — a malformed fixture fails here, loudly. */
const loadOpCase = (stepId: string): OpCaseFile => {
  const base = stepId.split("@")[0].toLowerCase()
  const raw = JSON.parse(fs.readFileSync(path.join(FIXTURES, "op-cases", "s4-s8", `${base}.json`), "utf8")) as {
    step_id: string
    skill_id?: string
    notes?: string
    ops: unknown
  }
  const parsed = opTransactionSchema.parse({ ops: raw.ops, notes: raw.notes })
  return { step_id: raw.step_id, skill_id: raw.skill_id, notes: parsed.notes, ops: parsed.ops }
}

/** The `${fn}` placeholder in a template fixture becomes the function id of this batch entry. */
const expandTemplate = (ops: OpTransaction["ops"], functionId: string): OpTransaction["ops"] =>
  JSON.parse(JSON.stringify(ops).split("${fn}").join(functionId)) as OpTransaction["ops"]

/**
 * Spine as T14 leaves it: minimal fixture + every S-1.2…S-3.5 op applied through the real engine.
 * `planTransaction` is pure (no DB), so this is a deterministic seed, not a second implementation.
 */
const seedAfterS3 = (): SpineT => {
  const ops = S2_S3_CASES.flatMap((file) => (readJson("op-cases", "s2-s3", `${file}.json`) as { ops: Op[] }).ops)
  const plan = planTransaction(MINIMAL, { base_version: MINIMAL.spine_version, ops, by: "seed" }, { startSeq: 1 })
  return plan.spine
}

/** Every step up to and including S-3.6 marked accepted, so `nextStep` lands on S-4.1. */
const acceptedThroughS3 = () => {
  const all = orderedSteps({ screens: [], functions: [] })
  return all
    .slice(0, all.findIndex((s) => s.id === "S-3.6") + 1)
    .map((s) => ({ id: s.id, status: "accepted" as const, first_seq: 1, last_seq: 1, accepted_at: "2026-01-01T00:00:00.000Z" }))
}

const seedSpine = (opts: { fast?: boolean } = {}): void => {
  const spine = seedAfterS3()
  spine.steps = acceptedThroughS3()
  spine.progress.current_phase = "S-3"
  spine.progress.current_step = "S-3.6"
  if (opts.fast) {
    spine.project.working_mode = "fast"
    spine.progress.elicit_turns_this_phase = 2
  }
  db.spines[0] = { _id: "spine", projectId: PROJECT, ...spine }
}

const seedSession = (): void => {
  db.sessions.push({ _id: SESSION, projectId: PROJECT, messages: [], isActive: true, is_pipeline: true })
}

const renderStub = (): Partial<DiagramServiceDeps> => {
  const store = createMemoryDiagramStore()
  const check: DiagramServiceDeps["check"] = async () =>
    ({ ok: true, method: "svg-scan", render: { format: "svg", data: Buffer.from("<svg/>"), contentType: "image/svg+xml", transport: "post", status: 200, diagnostics: {} } }) as CompileCheckResult
  return { check, renderPng: async () => Buffer.from("png"), store, now: () => new Date("2026-09-16T02:00:00.000Z") }
}

const collectEvents = () => {
  const events: StepEvent[] = []
  const emit = (e: StepEvent): void => {
    events.push(stepEventSchema.parse(e))
  }
  return { events, emit }
}

const estimateTokens = (text: string): number => Math.max(1, Math.ceil(text.length / 4))
const estimateCost = (tokensIn: number, tokensOut: number): number => Number(((tokensIn + tokensOut) * 0.000002).toFixed(6))

interface MeasuredUsage {
  step_id: string
  call_kind: "elicit" | "draft"
  functions_in_batch: number
  tokens_in: number
  tokens_out: number
  cost: number
}

/** Filled while the mock executors run — printed at the end for `docs/measurements.md`. */
const measuredUsage: MeasuredUsage[] = []

const elicitExecutor: StepRunnerDeps["elicitExecutor"] = async (input) => {
  const stepId = (input.promptVariables as { step_id: string }).step_id
  const tokensIn = estimateTokens(JSON.stringify(input.promptVariables))
  const tokensOut = estimateTokens("ok")
  const cost = estimateCost(tokensIn, tokensOut)
  measuredUsage.push({ step_id: stepId, call_kind: "elicit", functions_in_batch: 0, tokens_in: tokensIn, tokens_out: tokensOut, cost })

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

/** Function ids the runner put in THIS call's projection — the batch under `FUNCTION_BATCH_SIZE`. */
const batchFunctionIds = (promptVariables: Record<string, unknown>): string[] => {
  const projection = promptVariables.projection as Record<string, unknown>
  const key = Object.keys(projection).find((k) => k.startsWith("functions"))
  const list = key === undefined ? [] : projection[key]
  return Array.isArray(list) ? list.map((el) => (el as { id: string }).id) : []
}

/** Every (step, batch) the draft executor was asked for — the batching evidence. */
const draftCalls: { step_id: string; function_ids: string[] }[] = []

const draftExecutor: StepRunnerDeps["draftExecutor"] = async (actionType, input) => {
  const vars = input.promptVariables as Record<string, unknown>
  const stepId = vars.step_id as string
  const opCase = loadOpCase(stepId)
  const template = getStep(stepId).template_id
  const perFunction = template === "S-5.2" || template === "S-5.4"

  const batch = perFunction ? batchFunctionIds(vars) : []
  draftCalls.push({ step_id: stepId, function_ids: batch })
  const ops = perFunction ? batch.flatMap((id) => expandTemplate(opCase.ops, id)) : opCase.ops

  const tokensIn = estimateTokens(JSON.stringify(vars))
  const tokensOut = estimateTokens(JSON.stringify({ ops, notes: opCase.notes }))
  const cost = estimateCost(tokensIn, tokensOut)
  measuredUsage.push({ step_id: stepId, call_kind: "draft", functions_in_batch: batch.length, tokens_in: tokensIn, tokens_out: tokensOut, cost })

  const result: AiActionResult<OpTransaction> = {
    success: true,
    data: { ops, ...(opCase.notes ? { notes: opCase.notes } : {}) },
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
  draftCalls.length = 0
})

/** Walk `nextStep` from S-4.1 until `LAST_STEP`; run + accept each one. Returns the ids visited. */
const walkToLastStep = async (deps: Partial<StepRunnerDeps>): Promise<string[]> => {
  const visited: string[] = []
  for (let guard = 0; guard < 60; guard++) {
    const record = await repo.get(PROJECT)
    const next = nextStep({ screens: record!.screens, functions: record!.functions, steps: record!.steps })
    if (!next) break
    const { events, emit } = collectEvents()
    await runStep(PROJECT, next.id, SESSION, USER, emit, deps)
    expect(events.some((e) => e.type === "gate_ready"), `${next.id} must reach gate_ready`).toBe(true)
    const beforeGate = await repo.get(PROJECT)
    const result = await gate(PROJECT, next.id, USER, { action: "accept", base_version: beforeGate!.spine_version })
    expect(result.step.status, `${next.id} must be accepted`).toBe("accepted")
    visited.push(next.id)
    if (next.id === LAST_STEP) break
  }
  return visited
}

describe("T18: S-4.1 -> S-8.1 content skills end to end (mock provider)", () => {
  it("walks every step, fixes N at S-4.1, batches a 15-function screen, signs off core screens and leaves placeholders alone", async () => {
    seedSpine()
    seedSession()
    const deps: Partial<StepRunnerDeps> = { draftExecutor, elicitExecutor, renderDeps: renderStub() }

    const visited = await walkToLastStep(deps)
    const final = (await repo.get(PROJECT))!

    // ── S-4.1 fixed N: 4 screens + the nonscreen round; 51 + 5 x N steps ──────────────────────────
    expect(final.screens.map((s) => s.id).sort()).toEqual(["S91", "S92", "S93", "S94"])
    expect(final.progress.screen_queue).toEqual(["S91", "S92", "S93", "S94"])
    expect(final.functions.some((f) => f.screen_id === null), "S-4.4 must add a nonscreen function").toBe(true)
    expect(totalSteps(final), "N = 4 screens + 1 nonscreen round").toBe(51 + 5 * 5)

    // ── the loop ran only for the two core screens plus @nonscreen ────────────────────────────────
    const loopKeysRun = [...new Set(visited.filter((id) => id.includes("@")).map((id) => id.split("@")[1]))]
    expect(loopKeysRun).toEqual(["S91", "S92", "nonscreen"])
    expect(visited.filter((id) => id.startsWith("S-5.")).length, "5 loop steps per key").toBe(15)
    expect(visited).toContain("S-4.1")
    expect(visited).toContain("S-8.1")

    // ── S-5.1 moved the cursor; the @nonscreen round cleared it ───────────────────────────────────
    expect(final.progress.screen_cursor, "the last loop was @nonscreen").toBeNull()

    // ── S-5.5 accept signed the core screens off; placeholders untouched ──────────────────────────
    const byId = new Map(final.screens.map((s) => [s.id, s]))
    expect(byId.get("S91")!.detail_status).toBe("signed_off")
    expect(byId.get("S92")!.detail_status).toBe("signed_off")
    expect(byId.get("S93")!.detail_status).toBe("placeholder")
    expect(byId.get("S94")!.detail_status).toBe("placeholder")

    // Placeholder screens keep their functions[] frame and therefore raise no screen_pending_at_baseline
    expect(final.functions.filter((f) => f.screen_id === "S93")).toHaveLength(1)
    expect(final.functions.filter((f) => f.screen_id === "S94")).toHaveLength(1)
    expect(final.screens.some((s) => s.detail_status === "pending")).toBe(false)
    expect(final.flags.filter((f) => f.rule_id === "screen_pending_at_baseline" && f.resolved_at === null)).toEqual([])

    // ── batching: the 15-function screen took >= 3 draft calls with disjoint batches ──────────────
    const s54Calls = draftCalls.filter((c) => c.step_id === "S-5.4@S91")
    expect(s54Calls.length, `S-5.4@S91 must split 15 functions into batches of ${FUNCTION_BATCH_SIZE}`).toBeGreaterThanOrEqual(3)
    expect(s54Calls.every((c) => c.function_ids.length <= FUNCTION_BATCH_SIZE)).toBe(true)
    const batched = s54Calls.flatMap((c) => c.function_ids)
    expect(new Set(batched).size, "batches must be disjoint").toBe(batched.length)
    expect(batched.slice().sort()).toEqual(final.functions.filter((f) => f.screen_id === "S91").map((f) => f.id).sort())

    // The 2-function screen stayed a single call with the whole projection
    expect(draftCalls.filter((c) => c.step_id === "S-5.4@S92")).toHaveLength(1)

    // ── every function of a detailed screen really got detail ────────────────────────────────────
    for (const f of final.functions.filter((fn) => fn.screen_id === "S91" || fn.screen_id === "S92")) {
      expect(f.trigger, `${f.id} trigger`).not.toBe("")
      expect(f.description, `${f.id} description`).not.toBe("")
      expect(f.normal.length, `${f.id} normal[]`).toBeGreaterThan(0)
      expect(f.abnormal.length, `${f.id} abnormal[]`).toBeGreaterThan(0)
      expect(f.validations.length, `${f.id} validations[]`).toBeGreaterThan(0)
      expect(f.validations.some((v) => v.kind === "business"), `${f.id} needs a business validation for S-7.1`).toBe(true)
    }

    // ── S-6: reliability and performance carry numbers ───────────────────────────────────────────
    const quantitative = final.nfrs.filter((n) => n.category === "reliability" || n.category === "performance")
    expect(quantitative.length).toBeGreaterThanOrEqual(6)
    for (const n of quantitative) {
      expect(n.kind, `${n.id} kind`).toBe("quantitative")
      expect(n.metric, `${n.id} metric`).toBeTruthy()
      expect(n.threshold, `${n.id} threshold`).toBeTruthy()
    }
    expect(final.nfrs.filter((n) => n.category === "interface").length).toBeGreaterThan(0)
    expect(final.flags.filter((f) => f.rule_id === "nfr_missing_number" && f.resolved_at === null)).toEqual([])

    // ── S-7: appendix derived from section 3, with back-references ───────────────────────────────
    const detailRules = final.business_rules.filter((b) => b.tier === "detail")
    expect(detailRules.length).toBeGreaterThan(0)
    expect(detailRules.every((b) => b.source_validation_ids.length > 0), "detail rules must cite their validations").toBe(true)
    const validationIds = new Set(final.functions.flatMap((f) => f.validations.map((v) => v.id)))
    expect(detailRules.every((b) => b.source_validation_ids.every((id) => validationIds.has(id)))).toBe(true)

    expect(final.messages.length).toBeGreaterThan(0)
    const functionIds = new Set(final.functions.map((f) => f.id))
    expect(final.messages.every((m) => m.function_ids.length > 0 && m.function_ids.every((id) => functionIds.has(id)))).toBe(true)
    expect(final.messages.every((m) => /^[A-Z]+-\d{3}$/.test(m.code)), "message codes are AREA-NNN").toBe(true)
    expect(final.common_requirements.length).toBeGreaterThanOrEqual(3)
    expect(final.other_requirements.length).toBeGreaterThan(0)

    // ── S-8.1 glossary ───────────────────────────────────────────────────────────────────────────
    expect(final.glossary.length).toBeGreaterThanOrEqual(5)
    expect(new Set(final.glossary.map((g) => g.term)).size, "no duplicate terms").toBe(final.glossary.length)

    // ── no unwaivable red flag left open ─────────────────────────────────────────────────────────
    const NON_WAIVABLE = new Set(["array_empty", "dead_reference", "render_error"])
    const blocking = final.flags.filter((f) => f.level === "red" && f.resolved_at === null && NON_WAIVABLE.has(f.rule_id))
    expect(blocking, `unwaivable red flags: ${JSON.stringify(blocking)}`).toEqual([])

    console.log("[T18 measured usage — mock, char/4 estimate]", JSON.stringify(measuredUsage))
    console.log("[T18 draft calls per step]", JSON.stringify(draftCalls.map((c) => ({ step: c.step_id, n: c.function_ids.length }))))
  })

  it("S-5.1 accept_as_is leaves the screen as a placeholder and skips the rest of its loop", async () => {
    seedSpine()
    seedSession()
    const deps: Partial<StepRunnerDeps> = { draftExecutor, elicitExecutor, renderDeps: renderStub() }

    for (const stepId of ["S-4.1", "S-4.2", "S-4.3", "S-4.4", "S-4.5"]) {
      const { emit } = collectEvents()
      await runStep(PROJECT, stepId, SESSION, USER, emit, deps)
      const before = await repo.get(PROJECT)
      await gate(PROJECT, stepId, USER, { action: "accept", base_version: before!.spine_version })
    }

    const { emit } = collectEvents()
    await runStep(PROJECT, "S-5.1@S91", SESSION, USER, emit, deps)

    const afterRun = (await repo.get(PROJECT))!
    expect(afterRun.progress.screen_cursor, "S-5.1 sets the cursor").toBe("S91")
    expect(afterRun.screens.find((s) => s.id === "S91")!.detail_status, "S-5.1 starts the screen").toBe("in_progress")

    await gate(PROJECT, "S-5.1@S91", USER, {
      action: "accept_as_is",
      base_version: afterRun.spine_version,
      note: "Leave this screen for the next release; the frame is enough for now."
    })

    const afterGate = (await repo.get(PROJECT))!
    expect(afterGate.screens.find((s) => s.id === "S91")!.detail_status).toBe("placeholder")
    // Frame kept: the functions S-4.1 created are still there
    expect(afterGate.functions.filter((f) => f.screen_id === "S91").length).toBe(15)
    // The rest of S91's loop is skipped — nextStep jumps to the next screen
    const next = nextStep({ screens: afterGate.screens, functions: afterGate.functions, steps: afterGate.steps })
    expect(next?.id).toBe("S-5.1@S92")
  })

  it("every content SKILL.md of this task is <= 150 lines and its writes[] stay inside the registry writes of its steps", () => {
    const skillIds = [
      "screens-and-flow",
      "authorization-matrix",
      "non-screen-functions",
      "entities-erd",
      "function-detail",
      "nfr-quality-attributes",
      "appendix-content",
      "glossary"
    ] as const
    const SKILLS_DIR = path.resolve(__dirname, "../../../../assets/skills/content")
    const baseField = (write: string): string => write.split(/[.[]/)[0]
    // `STEP_SKILLS` is keyed by TEMPLATE id, so compare against the registry itself — `orderedSteps`
    // on an empty Spine has no S-5 rows at all (`S-5.x` only exists as `S-5.x@<loop>`).
    const registryStepIds = new Set(loadStepRegistry().map((s) => s.id))
    /** `getStep` needs the `@loop` suffix for a loop template. */
    const concreteId = (stepId: string): string => (loadStepRegistry().find((s) => s.id === stepId)?.kind === "loop" ? `${stepId}@nonscreen` : stepId)

    for (const skillId of skillIds) {
      const md = fs.readFileSync(path.join(SKILLS_DIR, skillId, "SKILL.md"), "utf8")
      const lineCount = md.split("\n").filter((_, i, arr) => !(i === arr.length - 1 && arr[i] === "")).length
      expect(lineCount, `${skillId}/SKILL.md must be <= 150 lines, has ${lineCount}`).toBeLessThanOrEqual(150)

      const mappedSteps = Object.entries(STEP_SKILLS)
        .filter(([stepId, s]) => s === skillId && registryStepIds.has(stepId))
        .map(([stepId]) => stepId)
      expect(mappedSteps.length, `${skillId} must map to at least one registry step`).toBeGreaterThan(0)

      const registryWrites = new Set(mappedSteps.flatMap((stepId) => getStep(concreteId(stepId)).writes))
      const skill = getSkill(skillId)
      expect(skill.stub, `${skillId} must no longer be a stub`).toBe(false)
      for (const write of skill.writes) {
        expect(
          registryWrites.has(baseField(write)),
          `${skillId} frontmatter writes "${write}" (base "${baseField(write)}") not in registry writes[${[...registryWrites].join(", ")}] of ${mappedSteps.join(", ")}`
        ).toBe(true)
      }
    }
  })
})

describe("T18: real provider (E2E_AI=1)", () => {
  // Same in-memory Spine/Change/Usage/ChatSession as above; only the executors are real. Fast mode +
  // two elicit turns already spent avoids blocking on `answer_needed` (no `submitAnswer` caller here).
  // Not runnable in the `unit` project (no Mongo for credit reserve) — use `npm run test:e2e-ai` or
  // `npm run measure:tokens -- --mode real-draft` for real-provider runs (see file header).
  it.skipIf(process.env.E2E_AI !== "1")(
    "S-4.1 -> S-8.1 via real provider: 0 unwaivable red flags, nfr_missing_number = 0, placeholders untouched",
    async () => {
      seedSpine({ fast: true })
      seedSession()
      const deps: Partial<StepRunnerDeps> = defaultStepRunnerDeps()

      await walkToLastStep(deps)

      const final = (await repo.get(PROJECT))!
      const NON_WAIVABLE = new Set(["array_empty", "dead_reference", "render_error"])
      expect(final.flags.filter((f) => f.level === "red" && f.resolved_at === null && NON_WAIVABLE.has(f.rule_id))).toEqual([])
      expect(final.flags.filter((f) => f.rule_id === "nfr_missing_number" && f.resolved_at === null)).toEqual([])
      expect(final.screens.some((s) => s.detail_status === "pending")).toBe(false)
      expect(final.glossary.length).toBeGreaterThan(0)
      console.log("[T18 real-provider usage]", JSON.stringify(measuredUsage))
    }
  )
})
