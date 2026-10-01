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
import { getSkill, interpolatePrompt } from "../../../shared/ai/prompt-registry.service.js"
import type { AiActionResult } from "../../../shared/ai/ai-action.types.js"
import { opTransactionSchema, type ElicitOutput, type OpTransaction } from "../../../shared/ai/response-parser.js"
import { hasIdea, runStep, submitAnswer, type StepRunnerDeps } from "../step-runner.service.js"
import { runPhase } from "../phase-runner.service.js"
import { NO_QUESTION_ACK_VI } from "../fast-path.js"
import { getRunState } from "../run-state.service.js"
import { ApiError } from "../../../shared/utils/api-error.js"
import { gate } from "../gate.service.js"
import { stepEventSchema, type StepEvent } from "../pipeline.dto.js"
import { briefCoreEntries } from "../../spine/brief-core.js"

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

/** `message`: tin chat của user mở lượt chạy — với B-2.1 đó là quyết định của user, điều kiện để giả định được xác nhận. */
const runAndAccept = async (stepId: string, message?: string): Promise<StepEvent[]> => {
  const { events, emit } = collect()
  await runStep(PROJECT, stepId, SESSION, USER, emit, { ...deps(), ...(message ? { message } : {}) })
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
    for (const stepId of BRIEF_STEPS) await runAndAccept(stepId)

    // Pha Brief giữ tầm nhìn/mục tiêu ở addendum lõi, không chạm project.vision/goals
    const afterBrief = (await repo.get(PROJECT))!
    expect(afterBrief.project.vision, "Brief không ghi project.vision").toBeNull()
    expect(afterBrief.project.goals).toEqual([])
    const core = briefCoreEntries(afterBrief)
    expect(core.vision, "B-1.1 ghi addendum vision").not.toBeNull()
    expect(core.goals.length, "B-1.1 ghi addendum goals").toBeGreaterThanOrEqual(3)

    for (const stepId of S1_STEPS) await runAndAccept(stepId)
    const final = (await repo.get(PROJECT))!

    // S-1.1 dựng project.vision/goals tiếng Anh, khớp 1:1 với addendum goals
    expect(final.project.vision, "S-1.1 dựng vision").toBeTruthy()
    expect(final.project.goals, "S-1.1 dựng goals 1:1").toEqual(core.goals.map((g) => g.content_en))
    expect(final.project.form_factor).toEqual(["web_app"])
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
    for (const stepId of BRIEF_STEPS) await runAndAccept(stepId, stepId === "B-2.1" ? "Đúng rồi, các điều bạn đoán đều đúng" : undefined)
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

  it("B-2.1 không có quyết định nào của user trong lượt ⇒ model không tự xác nhận giả định (giữ nguyên status)", async () => {
    seedEmpty()
    for (const stepId of BRIEF_STEPS) await runAndAccept(stepId)
    const final = (await repo.get(PROJECT))!
    expect(final.assumptions.length).toBeGreaterThan(0)
    expect(final.assumptions.filter((a) => a.status !== "unconfirmed")).toEqual([])
    expect(final.assumptions.every((a) => a.confirmed_at === null)).toBe(true)
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

  it("có ý tưởng ⇒ elicit nhận đúng message, hỏi form_factor + stakes chứ không hỏi tên; draft ghi addendum, form_factor, stakes, tin cổng từ notes", async () => {
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
    // FLF-232: nền tảng + mức độ hỏi bằng thẻ ở B-0.1; tên hệ thống dời xuống B-2.3
    expect(prompts[0].missing).toContain("project.form_factor")
    expect(prompts[0].missing).toContain("project.stakes")
    expect(prompts[0].missing).not.toContain("project.system_name")
    expect(String(prompts[0].conversation_summary)).toContain(IDEA)

    const final = (await repo.get(PROJECT))!
    expect(final.project).toMatchObject({ system_name: null, form_factor: ["mobile_app"], stakes: "production" })
    expect(final.addendum).toHaveLength(1)
    expect(final.assumptions.map((a) => a.path)).toEqual(["project.form_factor", "project.stakes"])
    expect(final.assumptions[0].statement_vi).toBe("Ưu tiên ứng dụng điện thoại.")
    // text_vi đi kèm giả định mới ở gate; dữ liệu không có statement_vi thì không có text_vi
    const gateReady = events.find((e) => e.type === "gate_ready") as Extract<StepEvent, { type: "gate_ready" }>
    // FLF-241: tin cổng dùng nguyên văn notes. notes không nhắc hai điều tạm hiểu ⇒ danh sách xác nhận cắt xuống rỗng, để
    // chip "Đúng rồi" chỉ xác nhận điều user đã đọc; hai điều đó ở lại `unconfirmed` cho S-9.1 gom.
    expect(gateReady.message_vi).toBe("Ứng dụng đặt lịch cắt tóc cho tiệm nhỏ.")
    expect(gateReady.new_assumptions).toEqual([])
    expect(final.assumptions.map((a) => a.status)).toEqual(["unconfirmed", "unconfirmed"])
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
    // FLF-232: trí nhớ xuyên bước — tin nhắn gắn với B-1.1 vẫn có mặt ở lượt hỏi của cả giai đoạn B-1
    expect(String(interview[0].conversation_summary)).toContain("Mục tiêu là giảm khách bỏ hẹn")
  })

  it("B-0.2 khi form_factor đã có sau B-0.1 ⇒ không gọi model (0 usage), vẫn tới gate", async () => {
    seedEmpty()
    const spine = db.spines[0] as { steps: unknown[]; project: Record<string, unknown> }
    spine.steps = acceptSteps(["B-0.1"])
    spine.project.form_factor = ["mobile_app"]
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
  it("B-1: tin nhắn trả lời câu mở ⇒ ghi sổ bằng trích đoạn đã kiểm của user, phỏng vấn xong, giai đoạn chạy tiếp", async () => {
    seedEmpty()
    ;(db.spines[0] as { steps: unknown[] }).steps = acceptSteps(["B-0.1", "B-0.2", "B-0.3"])
    const chatTurns: Record<string, unknown>[] = []
    const { events, emit } = collect()
    const run = runPhase(PROJECT, "B-1", SESSION, USER, emit, {
      elicitExecutor: async (input) => {
        const vars = input.promptVariables as Record<string, unknown>
        if (vars.chat_turn) {
          chatTurns.push(vars)
          return { ...elicitResult("Đã ghi mục tiêu.", []), data: { reply: "Đã ghi mục tiêu.", questions: [], settled: [{ topic_key: "goals", answer: "giảm 30% khách bỏ hẹn" }] } }
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
    expect(decision).toMatchObject({ answer: "giảm 30% khách bỏ hẹn", step_id: "B-1" })
    const messages = db.sessions[0].messages as { role: string; content: string; step: string }[]
    expect(messages.filter((m) => m.step === "B-1").map((m) => m.role)).toEqual(["ai", "user", "ai"]) // lượt hỏi (kèm câu hỏi) còn trong lịch sử sau khi user trả lời bằng chat
    expect(events.some((e) => e.type === "gate_ready" && e.step_id.startsWith("B-1."))).toBe(true)
  })
})

describe("FLF-232: tên hệ thống hỏi ở B-2.3, không hỏi sớm", () => {
  const B0_B1 = ["B-0.1", "B-0.2", "B-0.3", "B-1.1", "B-1.2", "B-1.3", "B-1.4", "B-1.5", "B-1.6"]
  const capture = (missingByStep: Map<string, unknown[]>): StepRunnerDeps["elicitExecutor"] => async (input) => {
    const vars = input.promptVariables as { step_id: string; missing: unknown[] }
    missingByStep.set(vars.step_id, vars.missing)
    return elicitResult("Tôi hiểu rồi.", [])
  }

  it("tên còn null: bước Brief thường (B-1.1) không có system_name trong missing, phỏng vấn đầu B-1 cũng không", async () => {
    seedEmpty()
    ;(db.spines[0] as { steps: unknown[] }).steps = acceptSteps(["B-0.1", "B-0.2", "B-0.3"])
    const missing = new Map<string, unknown[]>()
    await runPhase(PROJECT, "B-1", SESSION, USER, collect().emit, { elicitExecutor: capture(missing), draftExecutor: async () => draftResult([]), message: "Mục tiêu là giảm khách bỏ hẹn" })
    expect(missing.size).toBeGreaterThan(0)
    for (const [stepId, fields] of missing) expect(fields, stepId).not.toContain("project.system_name")
  })

  it("tên còn null: B-2.3 hỏi tên (system_name nằm trong missing); đã có tên thì không", async () => {
    seedEmpty()
    ;(db.spines[0] as { steps: unknown[] }).steps = acceptSteps([...B0_B1, "B-2.1", "B-2.2"])
    const missing = new Map<string, unknown[]>()
    await runStep(PROJECT, "B-2.3", SESSION, USER, collect().emit, { elicitExecutor: capture(missing), draftExecutor: async () => draftResult([]) })
    expect(missing.get("B-2.3")).toContain("project.system_name")

    db.reset()
    seedEmpty()
    ;(db.spines[0] as { steps: unknown[]; project: Record<string, unknown> }).steps = acceptSteps([...B0_B1, "B-2.1", "B-2.2"])
    ;(db.spines[0] as { project: Record<string, unknown> }).project.system_name = "Minh An Booking"
    const again = new Map<string, unknown[]>()
    await runStep(PROJECT, "B-2.3", SESSION, USER, collect().emit, { elicitExecutor: capture(again), draftExecutor: async () => draftResult([]) })
    expect(again.get("B-2.3") ?? []).not.toContain("project.system_name")
  })

  it("B-2.3 chọn tên qua thẻ ⇒ draft nhận câu trả lời, ghi system_name; tên gợi ý sai luật (đuôi System) bị lọc", async () => {
    seedEmpty()
    ;(db.spines[0] as { project: Record<string, unknown> }).project.vision = "Đặt lịch khám cho phòng khám nhỏ"
    ;(db.spines[0] as { steps: unknown[] }).steps = acceptSteps([...B0_B1, "B-2.1", "B-2.2"])
    const { events, emit } = collect()
    const run = runStep(PROJECT, "B-2.3", SESSION, USER, emit, {
      elicitExecutor: async () =>
        elicitResult("Brief đã đủ để đặt tên rồi.", [
          {
            question: "Bạn thích tên nào cho hệ thống?",
            topic_key: "system_name",
            header: "Tên",
            options: [{ label: "Minh An Booking (Khuyến nghị)", description: "Gần gũi" }, { label: "Minh An Clinic System" }, { label: "CarePoint" }],
            multiple: false
          }
        ] as never),
      draftExecutor: async (_type, input) => {
        expect(String((input.promptVariables as { answers: string }).answers)).toContain("CarePoint")
        return draftResult([{ op: "set", path: "project.system_name", value: "CarePoint" }], "Tôi đặt tên hệ thống là CarePoint. Ổn thì mình đi tiếp nhé.")
      }
    })
    await waitFor(events, "answer_needed")
    const asked = events.find((e) => e.type === "answer_needed") as Extract<StepEvent, { type: "answer_needed" }>
    const labels = (asked.questions[0].options ?? []).map((o) => (typeof o === "string" ? o : o.label))
    expect(labels).toEqual(["Minh An Booking (Khuyến nghị)", "CarePoint"])
    submitAnswer(PROJECT, "B-2.3", SESSION, { answers: [{ question_id: asked.questions[0].id, answer: "CarePoint" }] })
    await run
    expect((await repo.get(PROJECT))!.project.system_name).toBe("CarePoint")
  })
})

describe("FLF-232: tin nhắn cổng cuối giai đoạn", () => {
  it("phase_gate mang message_vi = tin của bước cuối; không notes ⇒ dựng tất định từ tóm tắt", async () => {
    seedEmpty()
    const { events, emit } = collect()
    await runPhase(PROJECT, "B-0", SESSION, USER, emit, {
      elicitExecutor: async () => elicitResult("Tôi hiểu rồi.", []),
      draftExecutor: async () =>
        draftResult([{ op: "add", path: "addendum[]", value: { id: "AD01", topic: "Booking", content: "Đặt lịch", content_en: "Booking", target_section: "fixed:1", captured_at: "2026-09-28T00:00:00.000Z" } }]),
      message: "Ứng dụng đặt lịch khám"
    })
    const phaseGate = events.find((e) => e.type === "phase_gate") as Extract<StepEvent, { type: "phase_gate" }>
    const gateReady = events.find((e) => e.type === "gate_ready") as Extract<StepEvent, { type: "gate_ready" }>
    expect(gateReady.message_vi).toMatch(/^Tôi đã cập nhật/)
    expect(phaseGate.message_vi).toBe(gateReady.message_vi)
    expect(gateReady.message_vi).not.toMatch(/Brief|giả định|ghi nhận/)
  })
})

describe("FLF-232 vòng sửa 1: cổng cuối giai đoạn nói mọi điều tạm hiểu của giai đoạn", () => {
  it("bước im lặng sinh giả định ⇒ phase_gate.new_assumptions = đúng các giả định còn chưa xác nhận và message_vi nói hết", async () => {
    seedEmpty()
    ;(db.spines[0] as { steps: unknown[] }).steps = acceptSteps(["B-0.1", "B-0.2", "B-0.3"])
    const spoken: Record<string, string> = {
      "B-1.2": "Tôi tạm hiểu số một về nhóm người dùng chính",
      "B-1.3": "Tôi tạm hiểu số hai về kênh thông báo",
      "B-1.4": "Tôi tạm hiểu số ba về phạm vi bản đầu",
      "B-1.5": "Tôi tạm hiểu số bốn về chỉ số thành công",
      "B-1.6": "Tôi tạm hiểu số năm về rủi ro chính"
    }
    let n = 0
    const { events, emit } = collect()
    await runPhase(PROJECT, "B-1", SESSION, USER, emit, {
      elicitExecutor: async () => elicitResult("Rõ rồi.", []),
      draftExecutor: async (_type, input) => {
        const stepId = (input.promptVariables as { step_id: string }).step_id
        const text = spoken[stepId]
        if (!text) return draftResult([])
        n += 1
        return draftResult([
          {
            op: "add",
            path: "assumptions[]",
            value: { id: `AS0${n}`, path: "project.vision", statement: `Assumption ${stepId}`, statement_vi: text, rationale: "r", origin_step_id: stepId, status: "unconfirmed", confirmed_at: null }
          }
        ])
      },
      message: "Mục tiêu là giảm khách bỏ hẹn"
    })

    const phaseGate = events.find((e) => e.type === "phase_gate") as Extract<StepEvent, { type: "phase_gate" }>
    // FLF-241: chỉ điều tin cổng thực sự nói ra được xác nhận. Tin của B-1.6 (đường dự phòng, không notes) nói điều của
    // chính B-1.6; bốn điều của các bước im còn lại chỉ được ĐẾM bằng một câu, nên không vào `new_assumptions`.
    expect(phaseGate.new_assumptions.map((a) => a.text_vi)).toEqual([spoken["B-1.6"]])
    expect(phaseGate.message_vi).toContain(spoken["B-1.6"])
    expect(phaseGate.message_vi).toContain("Còn 4 điều tôi tạm hiểu nữa, mình rà ở phần tổng kết.")
    for (const stepId of ["B-1.2", "B-1.3", "B-1.4", "B-1.5"]) expect(phaseGate.message_vi, stepId).not.toContain(spoken[stepId])
    expect(phaseGate.message_vi).not.toMatch(/điều nhỏ khác|giả định/)
    // Bước im lặng thật sự đã tự qua — điều tạm hiểu của chúng vẫn ở `unconfirmed` để S-9.1 gom, không mất dấu
    expect(events.filter((e) => e.type === "auto_accepted").length).toBeGreaterThan(0)
    expect((await repo.get(PROJECT))!.assumptions.filter((a) => a.status === "unconfirmed")).toHaveLength(5)
  })

  it("giả định đã xác nhận/bác bỏ không nằm trong danh sách cổng", async () => {
    seedEmpty()
    ;(db.spines[0] as { steps: unknown[] }).steps = acceptSteps(["B-0.1", "B-0.2", "B-0.3"])
    const { events, emit } = collect()
    await runPhase(PROJECT, "B-1", SESSION, USER, emit, {
      elicitExecutor: async () => elicitResult("Rõ rồi.", []),
      draftExecutor: async (_type, input) => {
        const stepId = (input.promptVariables as { step_id: string }).step_id
        if (stepId !== "B-1.2") return draftResult([])
        return draftResult([
          { op: "add", path: "assumptions[]", value: { id: "AS01", path: "project.vision", statement: "One", statement_vi: "Điều một", rationale: "r", origin_step_id: stepId, status: "unconfirmed", confirmed_at: null } }
        ])
      },
      message: "Mục tiêu là giảm khách bỏ hẹn"
    })
    // AS01 do B-1.2 sinh, tin cổng của B-1.6 không nhắc tới ⇒ không được xác nhận, chỉ vào câu đếm (FLF-241). Giả định đã
    // xác nhận/bác bỏ thì không vào cả hai: không trong `new_assumptions`, cũng không được đếm.
    const phaseGate = events.find((e) => e.type === "phase_gate") as Extract<StepEvent, { type: "phase_gate" }>
    expect(phaseGate.new_assumptions).toEqual([])
    expect(phaseGate.message_vi).toContain("Còn 1 điều tôi tạm hiểu nữa")
    const spine = (await repo.get(PROJECT))!
    expect(spine.assumptions.find((a) => a.id === "AS01")?.status).toBe("unconfirmed")
  })
})

describe("FLF-232 vòng sửa 1: phỏng vấn đầu giai đoạn", () => {
  it("phỏng vấn đầu B-2 không hỏi tên hệ thống (chỉ B-2.3 hỏi)", async () => {
    seedEmpty()
    ;(db.spines[0] as { steps: unknown[] }).steps = acceptSteps(["B-0.1", "B-0.2", "B-0.3", "B-1.1", "B-1.2", "B-1.3", "B-1.4", "B-1.5", "B-1.6"])
    const interview: Record<string, unknown>[] = []
    await runPhase(PROJECT, "B-2", SESSION, USER, collect().emit, {
      elicitExecutor: async (input) => {
        const vars = input.promptVariables as Record<string, unknown>
        if (vars.phase_interview) interview.push(vars)
        return elicitResult("Tôi hiểu rồi.", [])
      },
      draftExecutor: async () => draftResult([]),
      message: "Sang phần hoàn thiện"
    })
    for (const vars of interview) expect(vars.missing as string[]).not.toContain("project.system_name")
  })

  it("tin gõ kèm đáp án thẻ: đáp án thẻ vào transcript TRƯỚC lượt chat (model thấy, không hỏi lại) và lượt chat đọc transcript cả session", async () => {
    seedEmpty()
    ;(db.spines[0] as { steps: unknown[] }).steps = acceptSteps(["B-0.1", "B-0.2", "B-0.3"])
    const chatTurns: Record<string, unknown>[] = []
    const { events, emit } = collect()
    const run = runPhase(PROJECT, "B-1", SESSION, USER, emit, {
      elicitExecutor: async (input) => {
        const vars = input.promptVariables as Record<string, unknown>
        if (vars.chat_turn) {
          chatTurns.push(vars)
          return { ...elicitResult("Đã ghi mục tiêu.", []), data: { reply: "Đã ghi mục tiêu.", questions: [], settled: [{ topic_key: "goals", answer: "giảm 30% khách bỏ hẹn" }] } }
        }
        if (vars.phase_interview) {
          return elicitResult("Mình hỏi nhanh.", [
            { question: "Mục tiêu chính là gì?", topic_key: "goals", options: [] },
            { question: "Tầm nhìn đã đúng ý chưa?", topic_key: "vision_ok", options: [{ label: "Đúng như đề xuất" }, { label: "Cần sửa" }] }
          ] as never as ElicitOutput["questions"])
        }
        return elicitResult("Rõ rồi.", [])
      },
      draftExecutor: async () => draftResult([])
    })
    await waitFor(events, "answer_needed")
    submitAnswer(PROJECT, "B-1", SESSION, { answers: [{ question_id: "Q_vision_ok", answer: "Đúng như đề xuất" }], message: "Mục tiêu là giảm 30% khách bỏ hẹn" })
    await run

    expect(chatTurns).toHaveLength(1)
    // Lượt chat đọc transcript cả session (có sessionId): thấy cả đáp án thẻ lẫn tin gõ
    expect(String(chatTurns[0].recent_turns)).toContain("Đúng như đề xuất")
    expect(String(chatTurns[0].recent_turns)).toContain("Mục tiêu là giảm 30% khách bỏ hẹn")
    const messages = db.sessions[0].messages as { role: string; content: string; step: string }[]
    const users = messages.filter((m) => m.step === "B-1" && m.role === "user").map((m) => m.content)
    expect(users).toEqual(["Đúng như đề xuất", "Mục tiêu là giảm 30% khách bỏ hẹn"])
    const decisions = (await repo.get(PROJECT))!.decisions.map((d) => d.topic_key).sort()
    expect(decisions).toEqual(["goals", "vision_ok"])
  })
})

describe("fast path Brief: một lượt hỏi gộp, bước B-1.x viết trước, một cổng cuối", () => {
  const AFTER_B0 = ["B-0.1", "B-0.2", "B-0.3"]
  const TEXTS: Record<string, string> = {
    "B-1.1": "bệnh nhân tự chọn giờ khám trên điện thoại",
    "B-1.2": "lễ tân xác nhận lịch qua điện thoại",
    "B-1.3": "phòng khám nhỏ không có đối thủ trực tiếp",
    "B-1.4": "bản đầu chưa thanh toán trực tuyến",
    "B-1.5": "thành công là giảm 30% lượt bỏ hẹn",
    "B-1.6": "máy chủ đặt tại Việt Nam"
  }
  const SUMMARY = "Đây là hệ thống đặt lịch khám cho phòng khám nhỏ, giảm bỏ hẹn, rủi ro lớn nhất là dữ liệu sức khoẻ."

  const seedB1 = (opts: { reviewMode?: "fast" | "balanced" | "strict"; stakes?: string } = {}) => {
    seedEmpty()
    const spine = db.spines[0] as { steps: unknown[]; project: Record<string, unknown> }
    spine.steps = acceptSteps(AFTER_B0)
    if (opts.reviewMode) spine.project.review_mode = opts.reviewMode
    if (opts.stakes) spine.project.stakes = opts.stakes
  }

  /** Mỗi bước B-1.x ghi đúng một giả định tiếng Việt; B-1.6 kèm `notes` tóm tắt brief. `failOnce`: bước chết đúng một lần. */
  const drafts = (failOnce?: string, seen?: Record<string, string>): StepRunnerDeps["draftExecutor"] => {
    let failed = false
    const ids = Object.keys(TEXTS)
    return async (_type, input) => {
      const stepId = (input.promptVariables as { step_id: string }).step_id
      if (seen) seen[stepId] = JSON.stringify(input.promptVariables)
      if (!TEXTS[stepId]) return draftResult([])
      if (stepId === failOnce && !failed) {
        failed = true
        throw new ApiError(502, "provider chết", "AI_PROVIDER_ERROR")
      }
      const n = ids.indexOf(stepId) + 1
      return draftResult(
        [{ op: "add", path: "assumptions[]", value: { id: `AS0${n}`, path: "project.vision", statement: `Assumption ${stepId}`, statement_vi: TEXTS[stepId], rationale: "r", origin_step_id: stepId, status: "unconfirmed", confirmed_at: null } }],
        stepId === "B-1.6" ? SUMMARY : undefined
      )
    }
  }

  const trackedElicit = (interviewQuestions: ElicitOutput["questions"] = [], interviewReply = "Tôi đã đọc.") => {
    const calls: { step_id: string; vars: Record<string, unknown> }[] = []
    const executor: StepRunnerDeps["elicitExecutor"] = async (input) => {
      const vars = input.promptVariables as Record<string, unknown>
      calls.push({ step_id: String(vars.step_id), vars })
      return elicitResult(vars.phase_interview ? interviewReply : "Tôi đã đọc.", vars.phase_interview ? interviewQuestions : [])
    }
    return { calls, executor }
  }

  const gates = (events: StepEvent[]) => events.filter((e) => e.type === "phase_gate") as Extract<StepEvent, { type: "phase_gate" }>[]

  it("Cuối giai đoạn: 1 lượt hỏi gộp, B-1.1…B-1.5 tự Accept, một phase_gate ở B-1.6 nói đủ giả định của cả giai đoạn", async () => {
    seedB1({ reviewMode: "fast" })
    const elicit = trackedElicit()
    const { events, emit } = collect()
    const seen: Record<string, string> = {}

    const result = await runPhase(PROJECT, "B-1", SESSION, USER, emit, { elicitExecutor: elicit.executor, draftExecutor: drafts(undefined, seen), message: "Đặt lịch khám cho phòng khám nhỏ" })

    expect(elicit.calls.map((c) => c.step_id)).toEqual(["B-1"])
    expect(db.usages.filter((u) => u.call_kind === "elicit").map((u) => u.step_id)).toEqual(["B-1"])
    expect(events.filter((e) => e.type === "auto_accepted").map((e) => e.step_id)).toEqual(["B-1.1", "B-1.2", "B-1.3", "B-1.4", "B-1.5"])
    expect(events.filter((e) => e.type === "answer_needed")).toHaveLength(0)
    expect(result.stopped_at).toBe("B-1.6")
    const [phaseGate] = gates(events)
    expect(gates(events)).toHaveLength(1)
    expect(phaseGate.step_id).toBe("B-1.6")
    // FLF-241: `notes` của B-1.6 (SUMMARY) kể tóm tắt, không nói điều nào ra như lời đoán ⇒ không điều nào được xác nhận;
    // cả 6 điều của giai đoạn vào đúng MỘT câu đếm, thay cho 6 câu "Tôi tạm hiểu là …" nối nhau của chiều cũ.
    expect(phaseGate.new_assumptions).toEqual([])
    for (const text of Object.values(TEXTS)) expect(phaseGate.message_vi, text).not.toContain(text)
    expect(phaseGate.message_vi).toBe(`${SUMMARY} Còn 6 điều tôi tạm hiểu nữa, mình rà ở phần tổng kết.`)
    expect(phaseGate.message_vi?.match(/tạm hiểu/g)).toHaveLength(1)
    expect(phaseGate.message_vi).not.toMatch(/giả định|bước|giai đoạn/i)
    // Lượt hỏi gộp không hỏi gì: lời AI được phát và ghi làm dấu "đã phỏng vấn"; tin mở giai đoạn ghi đúng một lần dưới đơn vị
    const messages = db.sessions[0].messages as { role: string; step: string; content: string }[]
    expect(messages.filter((m) => m.role === "user")).toEqual([expect.objectContaining({ step: "B-1", content: "Đặt lịch khám cho phòng khám nhỏ" })])
    expect(messages.filter((m) => m.role === "ai" && m.step === "B-1")).toEqual([expect.objectContaining({ content: "Tôi đã đọc." })])
    expect(events.filter((e) => e.type === "elicit")).toEqual([{ type: "elicit", step_id: "B-1", delta: "Tôi đã đọc." }])
    // Mọi bước B-1.x thấy tin mở giai đoạn qua transcript của đơn vị
    for (const id of Object.keys(TEXTS)) expect(seen[id], id).toContain("Đặt lịch khám cho phòng khám nhỏ")
  })

  it("bước im không lộ cổng: gate_ready.auto, run-state không ở `gate`; cổng cuối ghi phase_gate vào run-state để sống qua reload", async () => {
    seedB1({ reviewMode: "fast" })
    const { events, emit } = collect()
    await runPhase(PROJECT, "B-1", SESSION, USER, emit, { elicitExecutor: trackedElicit().executor, draftExecutor: drafts(), message: "Đặt lịch khám" })

    const readyBy = (id: string) => events.find((e) => e.type === "gate_ready" && e.step_id === id) as Extract<StepEvent, { type: "gate_ready" }>
    for (const id of ["B-1.1", "B-1.2", "B-1.3", "B-1.4", "B-1.5"]) {
      expect(readyBy(id).auto, id).toBe(true)
      const run = await getRunState(PROJECT, id)
      expect(run?.status, id).toBe("done")
      expect(run?.gate_payload, id).toBeNull()
      expect(run?.phase_gate, id).toBeNull()
    }
    expect(readyBy("B-1.6").auto).toBeUndefined()
    const last = await getRunState(PROJECT, "B-1.6")
    expect(last?.status).toBe("gate")
    const [phaseGate] = gates(events)
    expect(last?.phase_gate).toEqual(phaseGate)
    expect((last?.phase_gate as typeof phaseGate).new_assumptions).toEqual([])
    expect((last?.phase_gate as typeof phaseGate).message_vi).toContain("Còn 6 điều tôi tạm hiểu nữa")
  })

  it("Mọi bước: bước dừng là cổng thật — không auto, run-state `gate`", async () => {
    seedB1({ reviewMode: "strict" })
    const { events, emit } = collect()
    await runPhase(PROJECT, "B-1", SESSION, USER, emit, { elicitExecutor: trackedElicit().executor, draftExecutor: drafts(), message: "Đặt lịch khám" })
    const ready = events.find((e) => e.type === "gate_ready") as Extract<StepEvent, { type: "gate_ready" }>
    expect(ready.step_id).toBe("B-1.1")
    expect(ready.auto).toBeUndefined()
    expect((await getRunState(PROJECT, "B-1.1"))?.status).toBe("gate")
  })

  it("chuỗi dừng giữa chừng rồi chạy tiếp ⇒ cổng cuối vẫn đếm đủ giả định của các bước đã chạy ở lượt trước", async () => {
    seedB1({ reviewMode: "fast" })
    const elicit = trackedElicit()
    const failing = runPhase(PROJECT, "B-1", SESSION, USER, collect().emit, { elicitExecutor: elicit.executor, draftExecutor: drafts("B-1.3"), message: "Đặt lịch khám" })
    await expect(failing).rejects.toBeInstanceOf(ApiError)

    const { events, emit } = collect()
    await runPhase(PROJECT, "B-1", SESSION, USER, emit, { elicitExecutor: elicit.executor, draftExecutor: drafts() })

    const [phaseGate] = gates(events)
    expect(phaseGate.step_id).toBe("B-1.6")
    // Số trong câu đếm dựng từ Spine, không từ bộ nhớ lượt chạy: 6 điều tính đủ cả các bước đã chạy ở lượt bị ngắt
    expect(phaseGate.message_vi).toContain("Còn 6 điều tôi tạm hiểu nữa")
    expect(phaseGate.new_assumptions).toEqual([])
    // Đúng một lượt hỏi gộp trên cả chuỗi bị ngắt rồi chạy tiếp, không lượt Elicit nào của B-1.x
    expect(elicit.calls.map((c) => c.step_id)).toEqual(["B-1"])
  })

  it("Mọi bước: dừng ở B-1.1 với cổng cùng kiểu tin, không Elicit; duyệt rồi chạy tiếp dừng ở B-1.2", async () => {
    seedB1({ reviewMode: "strict" })
    const elicit = trackedElicit()
    const first = collect()
    const result = await runPhase(PROJECT, "B-1", SESSION, USER, first.emit, { elicitExecutor: elicit.executor, draftExecutor: drafts(), message: "Đặt lịch khám" })

    expect(result.stopped_at).toBe("B-1.1")
    expect(gates(first.events)[0]).toMatchObject({ step_id: "B-1.1" })
    expect(gates(first.events)[0].message_vi).toContain(TEXTS["B-1.1"])
    expect(first.events.filter((e) => e.type === "auto_accepted")).toHaveLength(0)

    await gate(PROJECT, "B-1.1", USER, { action: "accept", base_version: await version() })
    const second = collect()
    const again = await runPhase(PROJECT, "B-1", SESSION, USER, second.emit, { elicitExecutor: elicit.executor, draftExecutor: drafts() })
    expect(again.stopped_at).toBe("B-1.2")
    expect(gates(second.events)[0].message_vi).toContain(TEXTS["B-1.2"])

    await gate(PROJECT, "B-1.2", USER, { action: "accept", base_version: await version() })
    const third = await runPhase(PROJECT, "B-1", SESSION, USER, collect().emit, { elicitExecutor: elicit.executor, draftExecutor: drafts() })
    expect(third.stopped_at).toBe("B-1.3")
    // Vào lại giai đoạn sau mỗi lần duyệt không chạy lại lượt hỏi gộp: đúng một lượt trên cả chuỗi
    expect(elicit.calls.map((c) => c.step_id)).toEqual(["B-1"])
  })

  describe("tin chat sau lượt hỏi gộp: một lượt hỏi duy nhất, đóng phỏng vấn", () => {
    const questions = [
      { question: "Bạn đo thành công bằng gì?", topic_key: "success_metrics", options: [] },
      { question: "Hồ sơ lưu bao lâu?", topic_key: "data_retention", options: [] }
    ] as never as ElicitOutput["questions"]

    const runInterview = async (chat: { reply: string; questions?: unknown[]; settled?: { topic_key: string; answer: string }[] }, message: string) => {
      seedB1({ reviewMode: "fast" })
      const chatCalls: Record<string, unknown>[] = []
      const executor: StepRunnerDeps["elicitExecutor"] = async (input) => {
        const vars = input.promptVariables as Record<string, unknown>
        if (vars.chat_turn) {
          chatCalls.push(vars)
          return { ...elicitResult(chat.reply, (chat.questions ?? []) as ElicitOutput["questions"]), data: { reply: chat.reply, questions: (chat.questions ?? []) as ElicitOutput["questions"], settled: chat.settled ?? [] } }
        }
        return elicitResult("Tôi đọc rồi.", vars.phase_interview ? questions : [])
      }
      const { events, emit } = collect()
      const run = runPhase(PROJECT, "B-1", SESSION, USER, emit, { elicitExecutor: executor, draftExecutor: drafts(), message: "Đặt lịch khám" })
      await waitFor(events, "answer_needed")
      expect(submitAnswer(PROJECT, "B-1", SESSION, { answers: [], message })).toBe(true)
      const result = await run
      return { events, chatCalls, result }
    }

    it("tin lạc đề: không hỏi tiếp (kể cả model viết lại câu), không ghi quyết định cho câu đang chờ, lời AI không còn câu hỏi, giai đoạn chạy tiếp", async () => {
      const { events, chatCalls, result } = await runInterview(
        {
          reply: "Ý bác sĩ bấm nút là một tính năng hay. Vậy bạn đo thành công bằng gì?",
          questions: [{ question: "Bạn đo thành công bằng gì?", topic_key: "success_metrics", options: [] }],
          settled: [{ topic_key: "success_metrics", answer: "bác sĩ bấm nút gọi số" }]
        },
        "bác sĩ bấm nút để gọi số tiếp theo"
      )
      expect(events.filter((e) => e.type === "answer_needed")).toHaveLength(1)
      expect(chatCalls).toHaveLength(1)
      expect(chatCalls[0]).toMatchObject({ close_interview: true, max_questions: 0 })
      const decisions = (await repo.get(PROJECT))!.decisions.map((d) => d.topic_key)
      expect(decisions).not.toContain("success_metrics")
      expect(decisions).not.toContain("data_retention")
      const elicitAfter = events.filter((e) => e.type === "elicit").map((e) => (e as { delta: string }).delta)
      expect(elicitAfter.some((text) => text.includes("?"))).toBe(false)
      expect(elicitAfter[elicitAfter.length - 1]).toContain("bác sĩ bấm nút là một tính năng hay")
      const messages = db.sessions[0].messages as { role: string; step: string; content: string }[]
      expect(messages.filter((m) => m.step === "B-1" && m.role === "ai").slice(-1)[0]?.content).not.toContain("?")
      // Phỏng vấn đóng: run-state `done`, chuỗi chạy tiếp tới cổng cuối
      expect((await getRunState(PROJECT, "B-1"))?.status).toBe("done")
      expect(result.stopped_at).toBe("B-1.6")
    })

    it("tin trả lời đúng một câu bằng trích đoạn nguyên văn: câu đó vào sổ, câu kia không, và cũng không hỏi tiếp", async () => {
      const { events, result } = await runInterview(
        { reply: "Ok, giờ tôi đã có mốc đo. Hồ sơ lưu bao lâu tôi sẽ tự đoán.", settled: [{ topic_key: "success_metrics", answer: "giảm 30% lượt bỏ hẹn" }] },
        "thành công là giảm 30% lượt bỏ hẹn trong 6 tháng"
      )
      const ledger = (await repo.get(PROJECT))!.decisions
      expect(ledger.find((d) => d.topic_key === "success_metrics")).toMatchObject({ answer: "giảm 30% lượt bỏ hẹn" })
      expect(ledger.some((d) => d.topic_key === "data_retention")).toBe(false)
      expect(events.filter((e) => e.type === "answer_needed")).toHaveLength(1)
      expect(result.stopped_at).toBe("B-1.6")
    })
  })

  it("lượt hỏi gộp có câu trả lời ⇒ bước đầu không nhận lại tin mở giai đoạn, không bước nào Elicit", async () => {
    seedB1({ reviewMode: "fast" })
    const elicit = trackedElicit([{ question: "Bạn lưu hồ sơ bao lâu?", topic_key: "data_retention", options: [] }] as never as ElicitOutput["questions"])
    const { events, emit } = collect()
    const run = runPhase(PROJECT, "B-1", SESSION, USER, emit, { elicitExecutor: elicit.executor, draftExecutor: drafts(), message: "Đặt lịch khám" })
    await waitFor(events, "answer_needed")
    const asked = events.find((e) => e.type === "answer_needed") as Extract<StepEvent, { type: "answer_needed" }>
    expect(submitAnswer(PROJECT, "B-1", SESSION, { answers: [{ question_id: asked.questions[0].id, answer: "5 năm" }] })).toBe(true)
    await run
    expect(elicit.calls.map((c) => c.step_id)).toEqual(["B-1"])
    expect(gates(events)).toHaveLength(1)
  })

  /**
   * FLF-241 cắt `gate_payload.new_assumptions` xuống phần tin cổng thực sự nói ra. Quyết định "bước im" KHÔNG được dùng tập
   * đã cắt đó: nó lọc giả định qua sổ quyết định để chặn bước tự Accept khi model vừa tạo điều trái với điều user đã chốt.
   * Dùng tập đã cắt thì giả định trái sổ mà tin không nhắc sẽ lọt, bước tự Accept, user không bao giờ thấy xung đột.
   */
  it("giả định trái sổ quyết định mà tin cổng không nhắc ⇒ bước vẫn dừng, không tự Accept", async () => {
    seedB1({ reviewMode: "fast" })
    ;(db.spines[0] as { decisions: unknown[] }).decisions = [
      { id: "DC01", topic_key: "concurrent_users", question: "Bao nhiêu lượt khám mỗi ngày?", answer: "800", step_id: "B-1", at: "2026-09-30T00:00:00.000Z", superseded_by: null }
    ]
    const { events, emit } = collect()
    await runPhase(PROJECT, "B-1", SESSION, USER, emit, {
      elicitExecutor: trackedElicit().executor,
      draftExecutor: async (_type, input) => {
        const stepId = (input.promptVariables as { step_id: string }).step_id
        if (stepId !== "B-1.4") return draftResult([])
        // `notes` không nhắc giả định này ⇒ nó rơi khỏi `new_assumptions`, nhưng vẫn phải chặn bước tự Accept
        return draftResult(
          [
            {
              op: "add",
              path: "assumptions[]",
              value: { id: "AS09", path: "project.vision", statement: "System handles 500 concurrent_users per day.", statement_vi: "Hệ thống đáp ứng 500 lượt khám mỗi ngày.", rationale: "r", origin_step_id: stepId, status: "unconfirmed", confirmed_at: null }
            }
          ],
          "Tôi dựng xong phần phạm vi. Bạn xem qua nhé."
        )
      },
      message: "Đặt lịch khám"
    })

    const ready = events.find((e) => e.type === "gate_ready" && e.step_id === "B-1.4") as Extract<StepEvent, { type: "gate_ready" }>
    expect(ready.auto, "B-1.4 không được tự Accept khi có giả định trái sổ").toBeUndefined()
    expect(events.filter((e) => e.type === "auto_accepted").map((e) => e.step_id)).not.toContain("B-1.4")
    // Payload vẫn bị cắt: tin không nói ra giả định đó nên nó không được chip "Đúng rồi" xác nhận
    expect(ready.new_assumptions).toEqual([])
  })

  it("phỏng vấn đã diễn ra trước đó mà lượt chạy mang tin mới ⇒ bước đầu nhận tin, Elicit chỉ giữ câu mâu thuẫn", async () => {
    seedB1({ reviewMode: "fast" })
    ;(db.spines[0] as { decisions: unknown[] }).decisions = [{ id: "DC01", topic_key: "uptime", question: "Uptime?", answer: "99%", step_id: "B-1", at: "2026-09-30T00:00:00.000Z", superseded_by: null }]
    const seen: string[] = []
    const { events, emit } = collect()
    await runPhase(PROJECT, "B-1", SESSION, USER, emit, {
      elicitExecutor: async (input) => {
        const vars = input.promptVariables as { step_id: string; user_message: string }
        seen.push(`${vars.step_id}:${vars.user_message}`)
        return elicitResult("Tôi đã đọc.", [{ question: "Bạn lưu hồ sơ bao lâu?", topic_key: "data_retention", options: [] }] as never as ElicitOutput["questions"])
      },
      draftExecutor: drafts(),
      message: "Thêm một ý nữa"
    })
    expect(seen).toEqual(["B-1.1:Thêm một ý nữa"])
    expect(events.filter((e) => e.type === "answer_needed")).toHaveLength(0)
    expect(gates(events)).toHaveLength(1)
  })

  it.each([
    ["internal", 2],
    ["regulated", 4],
    ["production", 4]
  ] as const)("lượt hỏi gộp: stakes %s ⇒ tối đa %i câu; prompt có projection hợp và việc của cả giai đoạn", async (stakes, max) => {
    seedB1({ reviewMode: "fast", stakes })
    const many = ["a", "b", "c", "d", "e"].map((k) => ({ question: `Câu ${k}?`, topic_key: `topic_${k}`, options: [] })) as never as ElicitOutput["questions"]
    const elicit = trackedElicit(many)
    const { events, emit } = collect()
    const run = runPhase(PROJECT, "B-1", SESSION, USER, emit, { elicitExecutor: elicit.executor, draftExecutor: drafts(), message: "Đặt lịch khám" })
    await waitFor(events, "answer_needed")
    const asked = events.find((e) => e.type === "answer_needed") as Extract<StepEvent, { type: "answer_needed" }>
    expect(asked.questions).toHaveLength(max)
    expect(submitAnswer(PROJECT, "B-1", SESSION, { answers: asked.questions.map((q) => ({ question_id: q.id, answer: "ok" })) })).toBe(true)
    await run

    const vars = elicit.calls[0].vars
    expect(vars.max_questions).toBe(max)
    expect(Object.keys(vars.projection as object).some((k) => k.startsWith("project:") && k.includes("stakes"))).toBe(true)
    expect(String(vars.content_guidance).split("\n")).toHaveLength(6)
  })

  it("giai đoạn ngoài fast path giữ lượt hỏi gộp cũ: projection rỗng, không guidance, trần prompt cũ", async () => {
    seedB1({ reviewMode: "fast" })
    const elicit = trackedElicit()
    ;(db.spines[0] as { steps: unknown[] }).steps = acceptSteps([...AFTER_B0, ...Object.keys(TEXTS)])
    await runPhase(PROJECT, "B-2", SESSION, USER, collect().emit, { elicitExecutor: elicit.executor, draftExecutor: async () => draftResult([]), message: "Sang phần sau" })
    const interview = elicit.calls.find((c) => c.vars.phase_interview)
    expect(interview, "B-2 có lượt hỏi gộp").toBeTruthy()
    expect(interview!.vars.projection).toEqual({})
    expect(interview!.vars.content_guidance).toBe("")
    expect(interview!.vars.max_questions).toBe(2)
  })

  it("mọi lượt hỏi không hỏi gì đều ghi dấu: không có tin user vẫn không gọi lại lượt hỏi gộp ở lần chạy sau", async () => {
    seedB1({ reviewMode: "strict" })
    const elicit = trackedElicit()
    await runPhase(PROJECT, "B-1", SESSION, USER, collect().emit, { elicitExecutor: elicit.executor, draftExecutor: drafts() })
    await gate(PROJECT, "B-1.1", USER, { action: "accept", base_version: await version() })
    await runPhase(PROJECT, "B-1", SESSION, USER, collect().emit, { elicitExecutor: elicit.executor, draftExecutor: drafts() })
    expect(elicit.calls.map((c) => c.step_id)).toEqual(["B-1"])
    const messages = db.sessions[0].messages as { role: string; step: string }[]
    expect(messages.filter((m) => m.step === "B-1")).toEqual([expect.objectContaining({ role: "ai" })])
  })

  it("tin gõ giữa B-1 sau lượt hỏi gộp: một lượt Elicit chỉ hỏi câu mâu thuẫn, lời AI trả lời user", async () => {
    seedB1({ reviewMode: "strict" })
    const elicit = trackedElicit()
    await runPhase(PROJECT, "B-1", SESSION, USER, collect().emit, { elicitExecutor: elicit.executor, draftExecutor: drafts(), message: "Đặt lịch khám" })
    await gate(PROJECT, "B-1.1", USER, { action: "accept", base_version: await version() })
    const { events, emit } = collect()
    await runPhase(PROJECT, "B-1", SESSION, USER, emit, { elicitExecutor: elicit.executor, draftExecutor: drafts(), message: "Lễ tân là người xác nhận lịch" })
    expect(elicit.calls.map((c) => c.step_id)).toEqual(["B-1", "B-1.2"])
    expect(elicit.calls[1].vars.elicit_policy).toBe("conflict_only")
    expect(events.filter((e) => e.type === "elicit")).toEqual([{ type: "elicit", step_id: "B-1.2", delta: "Tôi đã đọc." }])
    expect(events.filter((e) => e.type === "answer_needed")).toHaveLength(0)
  })

  it("lượt hỏi gộp bị cắt theo ngân sách: lời AI không còn nêu câu hỏi đã bị cắt", async () => {
    seedB1({ reviewMode: "fast", stakes: "internal" })
    const many = [["web", "đặt lịch trên web"], ["zalo", "nhắc lịch qua Zalo"], ["kho", "lưu hồ sơ ở kho lạnh"]].map(([k, t]) => ({ question: `Bạn có muốn ${t} không?`, topic_key: `topic_${k}`, options: [], inline: true })) as never as ElicitOutput["questions"]
    const elicit = trackedElicit(many, "Mình đã đọc rồi. Bạn có muốn đặt lịch trên web không? Bạn có muốn lưu hồ sơ ở kho lạnh không?")
    const { events, emit } = collect()
    const run = runPhase(PROJECT, "B-1", SESSION, USER, emit, { elicitExecutor: elicit.executor, draftExecutor: drafts(), message: "Đặt lịch khám" })
    await waitFor(events, "answer_needed")
    const asked = events.find((e) => e.type === "answer_needed") as Extract<StepEvent, { type: "answer_needed" }>
    expect(asked.questions.map((q) => q.text)).toEqual(["Bạn có muốn đặt lịch trên web không?", "Bạn có muốn nhắc lịch qua Zalo không?"])
    const reply = (events.find((e) => e.type === "elicit") as Extract<StepEvent, { type: "elicit" }>).delta
    expect(reply).toContain("đặt lịch trên web")
    expect(reply).not.toContain("kho lạnh")
    expect(submitAnswer(PROJECT, "B-1", SESSION, { answers: asked.questions.map((q) => ({ question_id: q.id, answer: "ok" })) })).toBe(true)
    await run
  })

  it("mọi câu của lượt hỏi gộp bị server bỏ (đã chốt) ⇒ lời AI thành lời nhận tin không có câu hỏi", async () => {
    seedB1({ reviewMode: "fast" })
    ;(db.spines[0] as { decisions: unknown[] }).decisions = [{ id: "DC01", topic_key: "data_retention", question: "Lưu bao lâu?", answer: "5 năm", step_id: "B-0.1", at: "2026-09-30T00:00:00.000Z", superseded_by: null }]
    const elicit = trackedElicit([{ question: "Bạn lưu hồ sơ bao lâu?", topic_key: "data_retention", options: [], inline: true }] as never as ElicitOutput["questions"], "Mình đã đọc. Bạn lưu hồ sơ bao lâu?")
    const { events, emit } = collect()
    await runPhase(PROJECT, "B-1", SESSION, USER, emit, { elicitExecutor: elicit.executor, draftExecutor: drafts(), message: "Đặt lịch khám" })
    expect(events.filter((e) => e.type === "elicit")).toEqual([{ type: "elicit", step_id: "B-1", delta: NO_QUESTION_ACK_VI }])
    const messages = db.sessions[0].messages as { role: string; step: string; content: string }[]
    expect(messages.filter((m) => m.role === "ai" && m.step === "B-1").map((m) => m.content)).toEqual([NO_QUESTION_ACK_VI])
  })

  it("bước B-1.x có tin mới: câu hỏi thường bị bỏ thì lời AI không còn hỏi nó (phát và ghi transcript)", async () => {
    seedB1({ reviewMode: "strict" })
    const calls: string[] = []
    const executor: StepRunnerDeps["elicitExecutor"] = async (input) => {
      const vars = input.promptVariables as { step_id: string; phase_interview?: boolean }
      calls.push(vars.step_id)
      return elicitResult(vars.phase_interview ? "Ok." : "Mình đã ghi lại. Bạn lưu hồ sơ bao lâu?", vars.phase_interview ? [] : ([{ question: "Bạn lưu hồ sơ bao lâu?", topic_key: "data_retention", options: [], inline: true }] as never as ElicitOutput["questions"]))
    }
    await runPhase(PROJECT, "B-1", SESSION, USER, collect().emit, { elicitExecutor: executor, draftExecutor: drafts(), message: "Đặt lịch khám" })
    await gate(PROJECT, "B-1.1", USER, { action: "accept", base_version: await version() })
    const { events, emit } = collect()
    await runPhase(PROJECT, "B-1", SESSION, USER, emit, { elicitExecutor: executor, draftExecutor: drafts(), message: "Lễ tân xác nhận lịch" })
    expect(calls).toEqual(["B-1", "B-1.2"])
    expect(events.filter((e) => e.type === "elicit")).toEqual([{ type: "elicit", step_id: "B-1.2", delta: NO_QUESTION_ACK_VI }])
    const messages = db.sessions[0].messages as { role: string; step: string; content: string }[]
    expect(messages.filter((m) => m.role === "ai" && m.step === "B-1.2").map((m) => m.content)).toEqual([NO_QUESTION_ACK_VI])
  })

  it("prompt lượt hỏi gộp: câu luật fast path chỉ có ở B-1, S-phase giữ lời cũ", async () => {
    const template = getSkill("elicit-loop").template
    const FAST_SENTENCE = "ONLY asking turn of the phase"
    seedB1({ reviewMode: "fast" })
    const elicit = trackedElicit()
    await runPhase(PROJECT, "B-1", SESSION, USER, collect().emit, { elicitExecutor: elicit.executor, draftExecutor: drafts(), message: "Đặt lịch khám" })
    const b1 = elicit.calls.find((c) => c.vars.phase_interview)!
    expect(interpolatePrompt(template, b1.vars)).toContain(FAST_SENTENCE)

    seedB1({ reviewMode: "fast" })
    ;(db.spines[0] as { steps: unknown[] }).steps = acceptSteps([...AFTER_B0, ...Object.keys(TEXTS)])
    const other = trackedElicit()
    await runPhase(PROJECT, "B-2", SESSION, USER, collect().emit, { elicitExecutor: other.executor, draftExecutor: async () => draftResult([]), message: "Sang phần sau" })
    const b2 = other.calls.find((c) => c.vars.phase_interview)!
    const b2Prompt = interpolatePrompt(template, b2.vars)
    expect(b2Prompt).not.toContain(FAST_SENTENCE)
    expect(b2Prompt).not.toContain("Depth by")
    expect(b2Prompt).not.toContain("{{#if")
    expect(b2Prompt).not.toContain("Conflict-only turn")
  })

})
