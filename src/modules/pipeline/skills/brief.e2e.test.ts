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
        if ("$push" in update) {
          const pushed = (update as { $push: { messages: unknown } }).$push.messages as { $each?: unknown[] }
          ;(row.messages as unknown[]).push(...(pushed && Array.isArray(pushed.$each) ? pushed.$each : [pushed]))
        }
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
import { hasIdea, runStep, submitAnswer, type StepRunnerDeps } from "../step-runner.service.js"
import { runPhase } from "../phase-runner.service.js"
import { getRunState } from "../run-state.service.js"
import { ApiError } from "../../../shared/utils/api-error.js"
import { gate } from "../gate.service.js"
import { stepEventSchema, type StepEvent } from "../pipeline.dto.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CASES = path.resolve(__dirname, "../../../../fixtures/op-cases/b0-s1")

const PROJECT = "650000000000000000000007"
const USER = "650000000000000000000016"
const SESSION = "sess-t20"

/** 12 step Brief + 4 step S-1 (Phases §5, §6.4; B-0.4 bỏ ở FLF-221). */
const BRIEF_STEPS = [
  "B-0.1", "B-0.2", "B-0.3",
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

  it("FLF-220: hỏi khi bước còn field trống, working_mode không còn cắt lượt hỏi", async () => {
    seedEmpty("fast")
    for (const stepId of BRIEF_STEPS.slice(0, 3)) await runAndAccept(stepId)
    expect(elicitTurns).toEqual(["B-0.1", "B-0.2", "B-0.3"])
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
    // 12 step Brief (Phases §5, B-0.4 bỏ ở FLF-221)
    expect(BRIEF_STEPS.filter((s) => s.startsWith("B-0"))).toHaveLength(3)
    expect(BRIEF_STEPS.filter((s) => s.startsWith("B-1"))).toHaveLength(6)
    expect(BRIEF_STEPS.filter((s) => s.startsWith("B-2"))).toHaveLength(3)
    for (const stepId of [...BRIEF_STEPS, ...S1_STEPS]) expect(getStep(stepId).id, stepId).toBe(stepId)
  })
})

// ─── FLF-221: mở đầu kiểu "kể hết → AI chỉ hỏi phần thiếu" ────────────────────────────────

const elicitResult = (reply: string, questions: ElicitOutput["questions"]): AiActionResult<ElicitOutput> => ({
  success: true,
  data: { reply, questions },
  rawText: "{}",
  actionType: "elicit" as never,
  provider: "mock",
  aiModel: "mock",
  tokensUsed: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  latencyMs: 1,
  logId: "elicit",
  cost: 1
})

const draftResult = (ops: OpTransaction["ops"], notes?: string): AiActionResult<OpTransaction> => ({
  success: true,
  data: { ops, ...(notes ? { notes } : {}) },
  rawText: "{}",
  actionType: "draft" as never,
  provider: "mock",
  aiModel: "mock",
  tokensUsed: { promptTokens: 30, completionTokens: 60, totalTokens: 90 },
  latencyMs: 1,
  logId: "draft",
  cost: 2
})

const waitFor = async (events: StepEvent[], type: StepEvent["type"]): Promise<void> => {
  for (let i = 0; i < 100 && !events.some((e) => e.type === type); i++) await new Promise((r) => setTimeout(r, 0))
}

const acceptSteps = (ids: string[]) =>
  ids.map((id) => ({ id, status: "accepted" as const, first_seq: null, last_seq: null, accepted_at: "2026-09-28T00:00:00.000Z" }))

const IDEA = "Ứng dụng đặt lịch cắt tóc trên điện thoại cho các tiệm nhỏ, khách tự chọn giờ và thợ."

describe("FLF-221: hasIdea", () => {
  const empty = { addendum: [] as unknown[], project: { vision: null as string | null } }
  it("có ý tưởng khi có addendum, vision, tài liệu, hoặc message không kèm intent no_idea", () => {
    expect(hasIdea({ spine: empty, documents: "" })).toBe(false)
    expect(hasIdea({ spine: { ...empty, addendum: [{}] }, documents: "" })).toBe(true)
    expect(hasIdea({ spine: { ...empty, project: { vision: "V" } }, documents: "" })).toBe(true)
    expect(hasIdea({ spine: empty, documents: "Tài liệu" })).toBe(true)
    expect(hasIdea({ spine: empty, documents: "", message: IDEA })).toBe(true)
    expect(hasIdea({ spine: empty, documents: "", message: "Mình chưa có ý tưởng", intent: "no_idea" })).toBe(false)
    expect(hasIdea({ spine: empty, documents: "", message: "   " })).toBe(false)
  })
})

describe("FLF-221: B-0 mở đầu bằng chat", () => {
  it("intent no_idea ⇒ elicit văn xuôi: câu hỏi không có option, không '(Khuyến nghị)'", async () => {
    seedEmpty()
    const prompts: Record<string, unknown>[] = []
    const { events, emit } = collect()
    const run = runStep(PROJECT, "B-0.1", SESSION, USER, emit, {
      draftExecutor: async () => draftResult([]),
      elicitExecutor: async (input) => {
        prompts.push(input.promptVariables as Record<string, unknown>)
        return elicitResult("Mình gợi ý vài hướng nhé.", [
          { question: "Công việc hằng ngày của bạn có việc gì mất thời gian?", topic_key: "daily_pain", options: [] },
          {
            question: "Bạn muốn làm cho ai?",
            topic_key: "audience",
            options: [
              { label: "Cho chính mình (Khuyến nghị)", description: "Dễ bắt đầu" },
              { label: "Cho khách hàng", description: "Cần hiểu thị trường" }
            ]
          }
        ] as ElicitOutput["questions"])
      },
      message: "Mình chưa có ý tưởng",
      intent: "no_idea"
    })
    await waitFor(events, "answer_needed")
    const asked = events.find((e) => e.type === "answer_needed") as Extract<StepEvent, { type: "answer_needed" }>
    expect(asked.questions).toHaveLength(2)
    expect(asked.questions.every((q) => q.options === undefined)).toBe(true)
    expect(JSON.stringify(asked.questions)).not.toContain("Khuyến nghị")
    expect(String(prompts[0].user_message)).toMatch(/^\[no_idea\]/)
    submitAnswer(PROJECT, "B-0.1", SESSION, { answers: [{ question_id: "Q1", answer: "Quản lý lịch hẹn" }] })
    await run
  })

  it("có ý tưởng ⇒ elicit nhận đúng message, không hỏi form_factor/stakes; draft ghi tên, addendum, form_factor, stakes kèm giả định", async () => {
    seedEmpty()
    const prompts: Record<string, unknown>[] = []
    const { events, emit } = collect()
    await runStep(PROJECT, "B-0.1", SESSION, USER, emit, {
      elicitExecutor: async (input) => {
        prompts.push(input.promptVariables as Record<string, unknown>)
        return elicitResult("Rõ rồi.", [])
      },
      draftExecutor: async () =>
        draftResult(
          [
            { op: "set", path: "project.system_name", value: "Salon Slot" },
            { op: "set", path: "project.form_factor", value: "mobile_app" },
            { op: "set", path: "project.stakes", value: "production" },
            { op: "add", path: "addendum[]", value: { id: "AD01", topic: "Booking", content: IDEA, content_en: "Barbershop booking app.", target_section: "fixed:1", captured_at: "2026-09-28T00:00:00.000Z" } },
            { op: "add", path: "assumptions[]", value: { id: "AS01", path: "project.form_factor", statement: "Mobile app first.", statement_vi: "Ưu tiên ứng dụng điện thoại.", rationale: "User said on the phone.", origin_step_id: "B-0.1", status: "unconfirmed", confirmed_at: null } },
            { op: "add", path: "assumptions[]", value: { id: "AS02", path: "project.stakes", statement: "Real customers, no regulation.", rationale: "Small shops.", origin_step_id: "B-0.1", status: "unconfirmed", confirmed_at: null } }
          ],
          "Ứng dụng đặt lịch cắt tóc cho tiệm nhỏ."
        ),
      message: IDEA
    })
    expect(events.some((e) => e.type === "gate_ready")).toBe(true)
    expect(prompts[0].user_message).toBe(IDEA)
    expect(prompts[0].missing).not.toContain("project.form_factor")
    expect(prompts[0].missing).not.toContain("project.stakes")

    const final = (await repo.get(PROJECT))!
    expect(final.project).toMatchObject({ system_name: "Salon Slot", form_factor: "mobile_app", stakes: "production" })
    expect(final.addendum).toHaveLength(1)
    expect(final.assumptions.map((a) => a.path)).toEqual(["project.form_factor", "project.stakes"])
    expect(final.assumptions[0].statement_vi).toBe("Ưu tiên ứng dụng điện thoại.")
    // text_vi đi kèm giả định mới ở gate; dữ liệu không có statement_vi thì không có text_vi
    const gateReady = events.find((e) => e.type === "gate_ready") as Extract<StepEvent, { type: "gate_ready" }>
    expect(gateReady.new_assumptions).toEqual([
      { id: "AS01", text: "Mobile app first.", text_vi: "Ưu tiên ứng dụng điện thoại." },
      { id: "AS02", text: "Real customers, no regulation." }
    ])
    const messages = db.sessions[0].messages as { role: string; content: string; step: string }[]
    expect(messages[0]).toMatchObject({ role: "user", content: IDEA, step: "B-0.1" })
  })

  it("/phases/B-0/run với message ⇒ B-0.1 thấy message trong transcript, không phỏng vấn gộp, dừng ở cổng B-0.1", async () => {
    seedEmpty()
    const elicitSteps: string[] = []
    const transcripts: string[] = []
    const { events, emit } = collect()
    const result = await runPhase(PROJECT, "B-0", SESSION, USER, emit, {
      elicitExecutor: async (input) => {
        const vars = input.promptVariables as { step_id: string; recent_turns: string }
        elicitSteps.push(vars.step_id)
        transcripts.push(vars.recent_turns)
        return elicitResult("Rõ rồi.", [])
      },
      draftExecutor: async () => draftResult([]),
      message: IDEA
    })
    expect(elicitSteps).toEqual(["B-0.1"])
    expect(transcripts[0]).toContain(IDEA)
    expect(result.stopped_at).toBe("B-0.1")
    const phaseGate = events.find((e) => e.type === "phase_gate") as Extract<StepEvent, { type: "phase_gate" }>
    expect(phaseGate.reason_vi).toContain("Chốt ý tưởng")
    const messages = db.sessions[0].messages as { role: string; step: string }[]
    expect(messages.filter((m) => m.role === "user" && m.step === "B-0.1")).toHaveLength(1)
  })

  it("B-1 vẫn phỏng vấn gộp đầu giai đoạn và thấy message của user", async () => {
    seedEmpty()
    ;(db.spines[0] as { steps: unknown[] }).steps = acceptSteps(["B-0.1", "B-0.2", "B-0.3"])
    const interview: Record<string, unknown>[] = []
    await runPhase(PROJECT, "B-1", SESSION, USER, collect().emit, {
      elicitExecutor: async (input) => {
        const vars = input.promptVariables as Record<string, unknown>
        if (vars.phase_interview) interview.push(vars)
        return elicitResult("Rõ rồi.", [])
      },
      draftExecutor: async () => draftResult([]),
      message: "Mục tiêu là giảm khách bỏ hẹn"
    })
    expect(interview).toHaveLength(1)
    expect(interview[0]).toMatchObject({ step_id: "B-1", user_message: "Mục tiêu là giảm khách bỏ hẹn" })
    expect(String(interview[0].recent_turns)).toContain("Mục tiêu là giảm khách bỏ hẹn")
  })

  it("B-0.2 khi form_factor đã có sau B-0.1 ⇒ không gọi model (0 usage), vẫn tới gate", async () => {
    seedEmpty()
    const spine = db.spines[0] as { steps: unknown[]; project: Record<string, unknown> }
    spine.steps = acceptSteps(["B-0.1"])
    spine.project.form_factor = "mobile_app"
    const elicit = vi.fn()
    const draft = vi.fn()
    const { events, emit } = collect()
    await runStep(PROJECT, "B-0.2", SESSION, USER, emit, { elicitExecutor: elicit, draftExecutor: draft })
    expect(events.some((e) => e.type === "gate_ready")).toBe(true)
    expect(elicit).not.toHaveBeenCalled()
    expect(draft).not.toHaveBeenCalled()
    expect(db.usages.filter((u) => u.step_id === "B-0.2")).toHaveLength(0)
  })

  it("session của project khác + message ⇒ 403, không ghi transcript", async () => {
    seedEmpty()
    db.sessions.push({ _id: "sess-other", projectId: "650000000000000000000099", messages: [], isActive: true, is_pipeline: true })
    const err = await runStep(PROJECT, "B-0.1", "sess-other", USER, collect().emit, { ...deps(), message: IDEA }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).statusCode).toBe(403)
    expect(db.sessions.every((s) => (s.messages as unknown[]).length === 0)).toBe(true)
  })
})

describe("FLF-221: sự kiện cho nhật ký hoạt động", () => {
  it("intake phát ở mọi step (kể cả không đổi phase); stage lưu vào run-state kèm `at`", async () => {
    seedEmpty()
    ;(db.spines[0] as { steps: unknown[] }).steps = acceptSteps(["B-0.1"])
    ;(db.spines[0] as { progress: Record<string, unknown> }).progress.current_phase = "B-0"
    const { events, emit } = collect()
    await runStep(PROJECT, "B-0.2", SESSION, USER, emit, deps())
    expect(events.some((e) => e.type === "intake")).toBe(true)

    const run = await getRunState(PROJECT, "B-0.2")
    const stored = (run?.events ?? []) as { type: string; at?: string }[]
    expect(stored.some((e) => e.type === "stage")).toBe(true)
    expect(stored.some((e) => e.type === "intake")).toBe(true)
    expect(stored.every((e) => typeof e.at === "string" && !Number.isNaN(Date.parse(e.at)))).toBe(true)
  })
})

describe("FLF-221: chat tự do trong phỏng vấn đầu giai đoạn", () => {
  it("B-1: tin nhắn trả lời câu mở ⇒ ghi sổ bằng nguyên văn user, phỏng vấn xong, giai đoạn chạy tiếp", async () => {
    seedEmpty()
    ;(db.spines[0] as { steps: unknown[] }).steps = acceptSteps(["B-0.1", "B-0.2", "B-0.3"])
    const chatTurns: Record<string, unknown>[] = []
    const { events, emit } = collect()
    const run = runPhase(PROJECT, "B-1", SESSION, USER, emit, {
      elicitExecutor: async (input) => {
        const vars = input.promptVariables as Record<string, unknown>
        if (vars.chat_turn) {
          chatTurns.push(vars)
          return { ...elicitResult("Đã ghi mục tiêu.", []), data: { reply: "Đã ghi mục tiêu.", questions: [], settled: [{ topic_key: "goals", answer: "giảm bỏ hẹn" }] } }
        }
        if (vars.phase_interview) return elicitResult("Mình hỏi nhanh.", [{ question: "Mục tiêu chính là gì?", topic_key: "goals", options: [] }] as never as ElicitOutput["questions"])
        return elicitResult("Rõ rồi.", [])
      },
      draftExecutor: async () => draftResult([])
    })
    await waitFor(events, "answer_needed")
    expect(submitAnswer(PROJECT, "B-1", SESSION, { answers: [], message: "Mục tiêu là giảm 30% khách bỏ hẹn" })).toBe(true)
    await run

    expect(chatTurns).toHaveLength(1)
    const decision = (await repo.get(PROJECT))!.decisions.find((d) => d.topic_key === "goals")
    expect(decision).toMatchObject({ answer: "Mục tiêu là giảm 30% khách bỏ hẹn", step_id: "B-1" })
    const messages = db.sessions[0].messages as { role: string; content: string; step: string }[]
    expect(messages.filter((m) => m.step === "B-1").map((m) => m.role)).toEqual(["ai", "user", "ai"]) // lượt hỏi (kèm câu hỏi) còn trong lịch sử sau khi user trả lời bằng chat
    expect(events.some((e) => e.type === "gate_ready" && e.step_id.startsWith("B-1."))).toBe(true)
  })
})
