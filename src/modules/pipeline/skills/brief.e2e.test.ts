/**
 * brief.e2e.test.ts
 * ─────────────────────────────────────────────────────────────────
 * T20: pha Discovery chạy trọn trên **một project rỗng** — B-0.1 → B-2.3 rồi S-1.1 → S-1.4 — qua
 * `step-runner.runStep` + `gate accept`, ghi thẳng vào Spine bằng op.
 *
 * Điểm khác bản cũ (audit B2/B3): Brief không còn nằm trong JSON tin nhắn và LLM không còn tự quyết
 * "đã đủ thông tin chưa". 13 step Brief + 4 step S-1 là step thật trong registry; user chốt ở gate;
 * mọi thứ user nói thành `project{}`, `addendum[]`, `assumptions[]`, `other_requirements[]`.
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

import * as repo from "../../spine/spine.repository.js"
import { getStep, nextStep } from "../step-registry.js"
import { STEP_SKILLS } from "../context-projection.js"
import { getSkill } from "../../../shared/ai/prompt-registry.service.js"
import type { AiActionResult } from "../../../shared/ai/ai-action.types.js"
import { opTransactionSchema, type ElicitOutput, type OpTransaction } from "../../../shared/ai/response-parser.js"
import { runStep, type StepRunnerDeps } from "../step-runner.service.js"
import { gate } from "../gate.service.js"
import { stepEventSchema, type StepEvent } from "../pipeline.dto.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CASES = path.resolve(__dirname, "../../../../fixtures/op-cases/b0-s1")

const PROJECT = "650000000000000000000007"
const USER = "650000000000000000000016"
const SESSION = "sess-t20"

/** 13 step Brief + 4 step S-1 (Phases §5, §6.4). */
const BRIEF_STEPS = [
  "B-0.1", "B-0.2", "B-0.3", "B-0.4",
  "B-1.1", "B-1.2", "B-1.3", "B-1.4", "B-1.5", "B-1.6",
  "B-2.1", "B-2.2", "B-2.3"
] as const
const S1_STEPS = ["S-1.1", "S-1.2", "S-1.3", "S-1.4"] as const

const loadOpCase = (stepId: string): OpTransaction => {
  const raw = JSON.parse(fs.readFileSync(path.join(CASES, `${stepId.toLowerCase()}.json`), "utf8")) as { ops: unknown; notes?: string }
  return opTransactionSchema.parse({ ops: raw.ops, notes: raw.notes })
}

/** Project HOÀN TOÀN rỗng — đúng tình huống "tạo project mới rồi bắt đầu nói chuyện". */
const seedEmpty = (mode: "coaching" | "fast" = "coaching"): void => {
  const spine = repo.createEmptySpine({ name: "Dự án mới", domain: null })
  if (mode === "fast") spine.project.working_mode = "fast"
  db.spines[0] = { _id: "spine", projectId: PROJECT, ...spine }
  db.sessions.push({ _id: SESSION, projectId: PROJECT, messages: [], isActive: true, is_pipeline: true })
}

const version = async (): Promise<number> => (await repo.get(PROJECT))!.spine_version

const collect = () => {
  const events: StepEvent[] = []
  return { events, emit: (e: StepEvent) => void events.push(stepEventSchema.parse(e)) }
}

let elicitTurns: string[] = []

const elicitExecutor: StepRunnerDeps["elicitExecutor"] = async (input) => {
  const stepId = (input.promptVariables as { step_id: string }).step_id
  elicitTurns.push(stepId)
  const result: AiActionResult<ElicitOutput> = {
    success: true,
    data: { reply: "Đã rõ, tôi ghi lại nhé.", questions: [] },
    rawText: "{}",
    actionType: "elicit" as never,
    provider: "mock",
    aiModel: "mock",
    tokensUsed: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    latencyMs: 1,
    logId: `elicit-${stepId}`,
    cost: 1
  }
  return result
}

const draftExecutor: StepRunnerDeps["draftExecutor"] = async (actionType, input) => {
  const stepId = (input.promptVariables as { step_id: string }).step_id
  const opCase = loadOpCase(stepId)
  const result: AiActionResult<OpTransaction> = {
    success: true,
    data: opCase,
    rawText: "{}",
    actionType: actionType as never,
    provider: "mock",
    aiModel: "mock",
    tokensUsed: { promptTokens: 30, completionTokens: 60, totalTokens: 90 },
    latencyMs: 1,
    logId: `draft-${stepId}`,
    cost: 2
  }
  return result
}

const deps = (): Partial<StepRunnerDeps> => ({ draftExecutor, elicitExecutor })

const runAndAccept = async (stepId: string): Promise<StepEvent[]> => {
  const { events, emit } = collect()
  await runStep(PROJECT, stepId, SESSION, USER, emit, deps())
  expect(events.some((e) => e.type === "gate_ready"), `${stepId} phải tới gate_ready`).toBe(true)
  const result = await gate(PROJECT, stepId, USER, { action: "accept", base_version: await version() })
  expect(result.step.status, `${stepId} phải accepted`).toBe("accepted")
  return events
}

beforeEach(() => {
  db.reset()
  elicitTurns = []
})

describe("T20: project rỗng đi trọn B-0.1 → B-2.3 → S-1.4 (mock provider)", () => {
  it("ghi project{}, addendum[], assumptions[], other_requirements[] bằng op — không còn nằm trong tin nhắn", async () => {
    seedEmpty()
    for (const stepId of [...BRIEF_STEPS, ...S1_STEPS]) await runAndAccept(stepId)

    const final = (await repo.get(PROJECT))!

    // Năm trường project mà pha Brief phải chốt
    expect(final.project.vision, "B-1.1 ghi vision").toBeTruthy()
    expect(final.project.goals.length, "B-1.1 ghi goals").toBeGreaterThanOrEqual(3)
    expect(final.project.form_factor).toBe("web_app")
    expect(final.project.stakes).toBe("production")
    expect(final.project.working_mode).toBe("coaching")

    // Brief lưu trong Spine, không trong transcript
    expect(final.addendum.length, "addendum >= 5").toBeGreaterThanOrEqual(5)
    expect(final.assumptions.length, "assumptions >= 2").toBeGreaterThanOrEqual(2)
    expect(final.other_requirements.length).toBeGreaterThan(0)
    expect(final.addendum.every((a) => a.content.length > 0 && a.content_en.length > 0), "cả hai ngôn ngữ").toBe(true)

    // Brief KHÔNG được chạm vào cấu trúc SRS
    expect(final.actors, "Brief không viết actors").toEqual([])
    expect(final.use_cases).toEqual([])
    expect(final.screens).toEqual([])
    expect(final.functions).toEqual([])
    expect(final.sections).toEqual([])

    // S-1.2 phân loại
    expect(final.project.type).toBe("web_application")
    expect(final.project.complexity).toBe("high")
  })

  it("B-2.1 chuyển giả định sang confirmed; B-2.2 để dành addendum chứ không xoá thông tin", async () => {
    seedEmpty()
    for (const stepId of BRIEF_STEPS) await runAndAccept(stepId)
    const final = (await repo.get(PROJECT))!

    const confirmed = final.assumptions.filter((a) => a.status === "confirmed")
    expect(confirmed.length, "B-2.1 xác nhận được giả định").toBeGreaterThanOrEqual(2)
    expect(confirmed.every((a) => a.confirmed_at !== null), "confirmed phải có mốc thời gian").toBe(true)
    expect(final.assumptions.some((a) => a.status === "unconfirmed"), "còn giả định để S-9.1 quét").toBe(true)

    // AD08 (chưa làm bản này) được "để dành": vẫn là addendum, nhưng đổi đích sang phụ lục §5.4 để
    // S-7.4 nhặt. B-2.2 chỉ được ghi addendum/assumptions theo step registry — không xoá thông tin.
    const parked = final.addendum.find((a) => a.id === "AD08")!
    expect(parked, "để dành chứ không bỏ").toBeTruthy()
    expect(parked.target_section).toBe("fixed:5.4")
    expect(parked.topic).toContain("Deferred")
  })

  it("approve B-2.3 mở S-1: nextStep trỏ S-1.1, và chạy S-1.1 đặt progress.current_phase = S-1", async () => {
    seedEmpty()
    for (const stepId of BRIEF_STEPS) await runAndAccept(stepId)

    const afterBrief = (await repo.get(PROJECT))!
    expect(afterBrief.progress.current_phase, "vẫn đang ở B-2 cho tới khi chạy step sau").toBe("B-2")
    expect(nextStep(afterBrief)?.id, "approve B-2.3 mở S-1.1").toBe("S-1.1")

    await runAndAccept("S-1.1")
    expect((await repo.get(PROJECT))!.progress.current_phase).toBe("S-1")

    // S-1.4 accepted thì bước kế là S-2.1
    for (const stepId of ["S-1.2", "S-1.3", "S-1.4"]) await runAndAccept(stepId)
    expect(nextStep((await repo.get(PROJECT))!)?.id).toBe("S-2.1")
  })

  it("Coaching hỏi mỗi step một lượt; Fast tối đa 2 lượt mỗi phase", async () => {
    seedEmpty("coaching")
    for (const stepId of BRIEF_STEPS.slice(0, 4)) await runAndAccept(stepId)
    expect(elicitTurns.length, "coaching: mỗi step một lượt elicit").toBe(4)

    db.reset()
    elicitTurns = []
    seedEmpty("fast")
    for (const stepId of BRIEF_STEPS.slice(0, 4)) await runAndAccept(stepId)
    const inB0 = elicitTurns.filter((id) => id.startsWith("B-0"))
    expect(inB0.length, "fast: tối đa 2 lượt trong phase B-0").toBeLessThanOrEqual(2)
  })

  it("skill của pha Brief đã viết thật và không khai ghi collection của SRS", () => {
    for (const skillId of ["product-brief", "brief-analysis"]) {
      const skill = getSkill(skillId)
      expect(skill.stub, `${skillId} không còn stub`).toBe(false)
      const roots = new Set(skill.writes.map((w) => w.split(/[.[]/)[0]))
      for (const forbidden of ["actors", "use_cases", "screens", "functions", "sections", "nfrs"]) {
        expect(roots.has(forbidden), `${skillId} không được ghi ${forbidden}`).toBe(false)
      }
    }
  })

  it("STEP_SKILLS ánh xạ đúng: B-* → product-brief, S-1.1/1.3/1.4 → brief-analysis, S-1.2 → project-classifier", () => {
    for (const stepId of BRIEF_STEPS) expect(STEP_SKILLS[stepId], stepId).toBe("product-brief")
    expect(STEP_SKILLS["S-1.1"]).toBe("brief-analysis")
    expect(STEP_SKILLS["S-1.3"]).toBe("brief-analysis")
    expect(STEP_SKILLS["S-1.4"]).toBe("brief-analysis")
    expect(STEP_SKILLS["S-1.2"]).toBe("project-classifier")
    // 13 step Brief đúng như Phases §5
    expect(BRIEF_STEPS.filter((s) => s.startsWith("B-0"))).toHaveLength(4)
    expect(BRIEF_STEPS.filter((s) => s.startsWith("B-1"))).toHaveLength(6)
    expect(BRIEF_STEPS.filter((s) => s.startsWith("B-2"))).toHaveLength(3)
    for (const stepId of [...BRIEF_STEPS, ...S1_STEPS]) expect(getStep(stepId).id, stepId).toBe(stepId)
  })
})
