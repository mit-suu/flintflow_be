import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect, vi, beforeEach } from "vitest"

/** Store trong bộ nhớ thay model Mongoose — cùng ngữ nghĩa op-engine.test.ts (T08). */
const db = vi.hoisted(() => {
  type Doc = Record<string, unknown>
  type Filter = Record<string, unknown>
  const spines: Doc[] = []
  const changes: Doc[] = []
  const copy = <X>(x: X): X => structuredClone(x)
  const matches = (doc: Doc, filter: Filter): boolean =>
    Object.entries(filter).every(([key, expected]) => {
      const actual = doc[key]
      if (typeof expected === "object" && expected !== null) {
        const e = expected as { $gte?: number; $lte?: number; $in?: unknown[] }
        if (e.$in) return e.$in.map(String).includes(String(actual))
        const n = Number(actual)
        return (e.$gte === undefined || n >= e.$gte) && (e.$lte === undefined || n <= e.$lte)
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
    find: async (filter: Filter) => changes.filter((c) => matches(c, filter)).sort(bySeq).map(copy),
    insertMany: async (docs: Doc[]) => {
      if (docs.some((d) => changes.some((c) => String(c.projectId) === String(d.projectId) && c.seq === d.seq))) {
        throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 })
      }
      changes.push(...docs.map(copy))
      return docs.map(copy)
    },
    deleteMany: async (filter: Filter) => {
      for (let i = changes.length - 1; i >= 0; i--) if (matches(changes[i], filter)) changes.splice(i, 1)
      return {}
    }
  }
  const reset = () => {
    spines.length = 0
    changes.length = 0
  }
  return { Spine, Change, spines, changes, reset }
})

vi.mock("./spine.model.js", () => ({ Spine: db.Spine }))
vi.mock("./change.model.js", () => ({ Change: db.Change }))

import { spineSchema } from "./spine.schema.js"
import type { Spine } from "./spine.types.js"
import * as repo from "./spine.repository.js"
import { computeStatus } from "./section-status.js"
import { TransactionRejectedError } from "./op-engine.js"
import {
  NeedsClarificationError,
  apply,
  branchOf,
  buildChangeProjection,
  clearPreviewStore,
  isChangeInstruction,
  preview,
  referencedSections,
  sectionCollections,
  type ChangeDeps
} from "./change.service.js"
import { AiActionError, type AiActionResult } from "../../shared/ai/ai-action.types.js"
import type { ChangeInstructionOutput } from "../../shared/ai/response-parser.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE: Spine = spineSchema.parse(
  JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/spine-fixture-19-screens.json"), "utf8"))
)

const PROJECT = "650000000000000000000001"
const USER = "650000000000000000000010"

/**
 * Fixture mô tả 68 step đã accepted với `first_seq/last_seq` tới 204, nhưng collection `changes` rỗng.
 * Gieo một change mốc ở đúng seq cuối cùng đó để `nextSeq` tiếp tục từ 205 — nếu không, change mới sẽ
 * mang seq 1 và `section-status` coi là "cũ hơn mốc accept" nên không bao giờ stale.
 */
const seed = async (spine: Spine = FIXTURE): Promise<void> => {
  await repo.getOrCreate(PROJECT)
  db.spines[0] = { _id: "spine", projectId: PROJECT, ...structuredClone(spine) }

  const lastSeq = Math.max(0, ...spine.steps.map((s) => s.last_seq ?? 0))
  if (lastSeq === 0) return
  const lastStep = spine.steps.find((s) => s.last_seq === lastSeq)
  db.changes.push({
    projectId: PROJECT,
    seq: lastSeq,
    txn: "seed",
    op: "set",
    // Path không ánh xạ section nào (`sectionsOfPath` trả rỗng) — change mốc không được tự làm section stale
    path: "progress.elicit_turns_this_phase",
    before: 0,
    value: 0,
    reason: "seed fixture",
    at: "2026-09-01T00:00:00.000Z",
    by: "system",
    step_id: lastStep?.id ?? null
  })
}

/** Số change đã ghi, không tính change mốc do `seed` gieo. */
const writtenChanges = async (): Promise<number> => (await repo.listChanges(PROJECT)).filter((c) => c.txn !== "seed").length

const aiResult = (data: ChangeInstructionOutput): AiActionResult<ChangeInstructionOutput> =>
  ({
    success: true,
    data,
    rawText: JSON.stringify(data),
    actionType: "change_instruction",
    provider: "mock",
    aiModel: "mock",
    tokensUsed: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    cost: 1,
    logId: null
  }) as unknown as AiActionResult<ChangeInstructionOutput>

let deps: ChangeDeps

beforeEach(() => {
  db.reset()
  clearPreviewStore()
  deps = {
    changeExecutor: vi.fn(async () => aiResult({ ops: [] })),
    recomputeFlags: vi.fn(async () => undefined)
  }
})

// ─── nhánh ───────────────────────────────────────────────────────

describe("branchOf — ba nhánh", () => {
  const empty = { fields: [], sections: [], diagrams: [], referrers: [] }

  it("không phụ thuộc gì ⇒ silent", () => {
    expect(branchOf({ baselines: [] }, empty)).toBe("silent")
  })

  it("có section đọc / hình phải vẽ lại / khoá trỏ tới ⇒ dependent", () => {
    expect(branchOf({ baselines: [] }, { ...empty, sections: [{ id: "fixed:2.2.2", relation: "reads" }] })).toBe("dependent")
    expect(branchOf({ baselines: [] }, { ...empty, diagrams: ["usecase"] })).toBe("dependent")
    expect(branchOf({ baselines: [] }, { ...empty, referrers: [{ path: "roles[id=R1].actor_id", id: "A01" }] })).toBe("dependent")
  })

  it("chỉ section sở hữu ⇒ vẫn silent", () => {
    expect(branchOf({ baselines: [] }, { ...empty, sections: [{ id: "fixed:1", relation: "owner" }] })).toBe("silent")
  })

  it("đã có baseline ⇒ post_baseline, kể cả khi không ai phụ thuộc", () => {
    const baseline = [{ id: "B1", version: "v1.0", type: "generated" as const, doc_version: null, at: "2026-09-01T00:00:00.000Z", snapshot_ref: "x", checked_at_version: 1, waived_count: 0 }]
    expect(branchOf({ baselines: baseline }, empty)).toBe("post_baseline")
  })
})

// ─── preview ─────────────────────────────────────────────────────

describe("preview — diff + impact, không ghi", () => {
  it("lô ops thuần: diff đầy đủ, branch dependent, preview_id để xác nhận", async () => {
    await seed()
    const result = await preview(PROJECT, USER, { base_version: 1, ops: [{ op: "set", path: "actors[id=A01].name", value: "Product Owner" }] }, {}, deps)

    expect(result.ok).toBe(true)
    expect(result.branch).toBe("dependent")
    expect(result.changes).toHaveLength(1)
    expect(result.changes[0]).toMatchObject({ path: "actors[id=A01].name", before: "Founder", value: "Product Owner" })
    expect(result.impact?.sections.map((s) => s.id)).toEqual(expect.arrayContaining(["fixed:2.1", "fixed:2.2.2", "fixed:3.1.3"]))
    expect([...(result.impact?.diagrams ?? [])].sort()).toEqual(["context", "screen_flow", "usecase"])
    expect(result.preview_id).toBeTypeOf("string")

    // Không ghi gì: version giữ nguyên, changes[] rỗng
    expect((await repo.get(PROJECT))?.spine_version).toBe(1)
    expect(await writtenChanges()).toBe(0)
  })

  it("sửa field không ai đọc ⇒ branch silent", async () => {
    await seed()
    const result = await preview(PROJECT, USER, { base_version: 1, ops: [{ op: "set", path: "project.vision", value: "Tầm nhìn mới" }] }, {}, deps)
    expect(result.branch).toBe("silent")
    expect(result.impact?.diagrams).toEqual([])
  })

  it("lô phá bất biến ⇒ ok=false kèm violations, không ném", async () => {
    await seed()
    const result = await preview(PROJECT, USER, { base_version: 1, ops: [{ op: "set", path: "screens[id=S01].feature_id", value: "F999" }] }, {}, deps)

    expect(result.ok).toBe(false)
    expect(result.violations.map((v) => v.rule)).toContain("invariant_3_dead_reference")
    expect(result.preview_id).toBeUndefined()
  })

  it("gốc hệ thống quản lý ⇒ ok=false với path_not_writable, không gọi engine", async () => {
    await seed()
    const result = await preview(
      PROJECT,
      USER,
      { base_version: 1, ops: [{ op: "set", path: "flags[id=FL001].resolved_at", value: null }, { op: "set", path: "progress.current_step", value: "S-9.5" }] },
      {},
      deps
    )
    expect(result.ok).toBe(false)
    expect(result.violations.map((v) => [v.rule, v.op_index])).toEqual([
      ["path_not_writable", 0],
      ["path_not_writable", 1]
    ])
  })

  it("pha Brief: ghi project.vision/goals bị path_not_writable; pha S-* vẫn ghi được", async () => {
    const brief: Spine = { ...structuredClone(FIXTURE), progress: { ...FIXTURE.progress, current_phase: "B-1" } }
    await seed(brief)
    const ops = [
      { op: "set" as const, path: "project.vision", value: "x" },
      { op: "set" as const, path: "project.goals", value: ["y"] }
    ]
    const blocked = await preview(PROJECT, USER, { base_version: 1, ops }, {}, deps)
    expect(blocked.ok).toBe(false)
    expect(blocked.violations.map((v) => [v.rule, v.op_index])).toEqual([
      ["path_not_writable", 0],
      ["path_not_writable", 1]
    ])
    expect(blocked.violations[0].message).toContain("addendum")

    await seed()
    const allowed = await preview(PROJECT, USER, { base_version: 1, ops }, {}, deps)
    expect(allowed.ok).toBe(true)
  })

  it("project mới (current_phase null, chưa step nào accepted) cũng bị chặn ghi project.vision/goals; đã có step accepted thì không", async () => {
    const fresh: Spine = {
      ...structuredClone(FIXTURE),
      progress: { ...FIXTURE.progress, current_phase: null },
      steps: FIXTURE.steps.map((step) => ({ ...step, status: "pending" as const, accepted_at: null }))
    }
    await seed(fresh)
    const ops = [{ op: "set" as const, path: "project.vision", value: "x" }]
    const blocked = await preview(PROJECT, USER, { base_version: 1, ops }, {}, deps)
    expect(blocked.violations.map((v) => v.rule)).toEqual(["path_not_writable"])

    await seed({ ...fresh, steps: FIXTURE.steps.map((step, i) => (i === 0 ? { ...step, status: "accepted" as const } : { ...step, status: "pending" as const })) })
    expect((await preview(PROJECT, USER, { base_version: 1, ops }, {}, deps)).ok).toBe(true)
  })

  it("pha Brief: set nguyên object project giữ nguyên vision/goals vẫn qua; đổi vision thì bị chặn", async () => {
    const brief: Spine = { ...structuredClone(FIXTURE), project: { ...FIXTURE.project, vision: null, goals: [] }, progress: { ...FIXTURE.progress, current_phase: "B-0" } }
    await seed(brief)
    const same = [{ op: "set" as const, path: "project", value: { ...brief.project, stakes: "production" } }]
    expect((await preview(PROJECT, USER, { base_version: 1, ops: same }, {}, deps)).violations.map((v) => v.rule)).not.toContain("path_not_writable")
    const changed = [{ op: "set" as const, path: "project", value: { ...brief.project, vision: "x" } }]
    expect((await preview(PROJECT, USER, { base_version: 1, ops: changed }, {}, deps)).violations.map((v) => v.rule)).toEqual(["path_not_writable"])
  })

  it("base_version lệch ⇒ 409 SPINE_VERSION_CONFLICT", async () => {
    await seed()
    await expect(preview(PROJECT, USER, { base_version: 99, ops: [{ op: "set", path: "project.vision", value: "x" }] }, {}, deps)).rejects.toMatchObject({
      statusCode: 409,
      code: "SPINE_VERSION_CONFLICT"
    })
  })
})

// ─── nhánh instruction ───────────────────────────────────────────

describe("instruction — câu lệnh tự nhiên qua skill apply-change-op", () => {
  it("model trả ops ⇒ preview như lô thường", async () => {
    await seed()
    deps.changeExecutor = vi.fn(async () =>
      aiResult({ ops: [{ op: "set", path: "actors[id=A01].name", value: "Product Owner", reason: "đổi tên theo yêu cầu" }] })
    )

    const result = await preview(PROJECT, USER, { base_version: 1, instruction: "Đổi tên actor A01 thành Product Owner" }, {}, deps)

    expect(result.ok).toBe(true)
    expect(result.changes[0]).toMatchObject({ path: "actors[id=A01].name", value: "Product Owner" })
    expect(deps.changeExecutor).toHaveBeenCalledTimes(1)
  })

  it("lệnh mơ hồ ⇒ preview trả clarification (200), apply ném 409 NEEDS_CLARIFICATION", async () => {
    await seed()
    deps.changeExecutor = vi.fn(async () => aiResult({ clarification_needed: "Bạn muốn đổi actor nào — A01 hay A03?" }))

    const result = await preview(PROJECT, USER, { base_version: 1, instruction: "đổi tên admin" }, {}, deps)
    expect(result.ok).toBe(false)
    // Mã actor model còn chép được đổi sang tên trước khi tới user
    expect(result.clarification).toBe("Bạn muốn đổi actor nào — 'Founder' hay 'Administrator'?")
    expect(result.changes).toHaveLength(0)

    await expect(apply(PROJECT, USER, { base_version: 1, instruction: "đổi tên admin" }, {}, deps)).rejects.toBeInstanceOf(NeedsClarificationError)
  })

  it("trả lời câu hỏi làm rõ ⇒ model đọc đoạn hội thoại trước, projection dò cả yêu cầu gốc", async () => {
    await seed()
    deps.changeExecutor = vi.fn(async () => aiResult({ ops: [{ op: "set", path: "actors[id=A01].name", value: "Product Owner" }] }))

    await preview(
      PROJECT,
      USER,
      {
        base_version: 1,
        instruction: "cái thứ nhất",
        chat_history: "User: đổi tên A01 thành Product Owner\nAI: Bạn muốn đổi actor nào — A01 hay A03?"
      },
      {},
      deps
    )

    const variables = vi.mocked(deps.changeExecutor).mock.calls[0][1].promptVariables as Record<string, unknown>
    expect(variables.user_message).toBe("cái thứ nhất")
    expect(variables.chat_history).toContain("A01 hay A03")
    expect(((variables.projection as { actors?: { id: string }[] }).actors ?? []).map((a) => a.id)).toContain("A01")
  })

  it("không có lịch sử ⇒ chat_history là (none), không để placeholder trống", async () => {
    await seed()
    deps.changeExecutor = vi.fn(async () => aiResult({ ops: [{ op: "set", path: "actors[id=A01].name", value: "X" }] }))
    await preview(PROJECT, USER, { base_version: 1, instruction: "Đổi tên A01 thành X" }, {}, deps)
    const variables = vi.mocked(deps.changeExecutor).mock.calls[0][1].promptVariables as Record<string, unknown>
    expect(variables.chat_history).toBe("(none)")
  })

  it("apply với preview_id dùng lại lô đã xem, không gọi model lần hai", async () => {
    await seed()
    deps.changeExecutor = vi.fn(async () => aiResult({ ops: [{ op: "set", path: "actors[id=A01].name", value: "Product Owner" }] }))

    const previewed = await preview(PROJECT, USER, { base_version: 1, instruction: "Đổi tên A01" }, {}, deps)
    const applied = await apply(PROJECT, USER, { base_version: 1, instruction: "Đổi tên A01", preview_id: previewed.preview_id }, {}, deps)

    expect(deps.changeExecutor).toHaveBeenCalledTimes(1)
    expect(applied.spine.actors.find((a) => a.id === "A01")?.name).toBe("Product Owner")
  })

  it("FLF-243: model tự đặt tên use case sai luật ⇒ gọi lại MỘT lần kèm lỗi, preview dùng lô sửa lại", async () => {
    await seed()
    deps.changeExecutor = vi
      .fn()
      .mockResolvedValueOnce(aiResult({ ops: [{ op: "set", path: "use_cases[id=UC05].name", value: "Create, Update and Delete Projects" }] }))
      .mockResolvedValueOnce(aiResult({ ops: [{ op: "set", path: "use_cases[id=UC05].name", value: "Find Project" }] }))

    const result = await preview(PROJECT, USER, { base_version: 1, instruction: "Đổi tên UC05 cho cụ thể hơn" }, {}, deps)

    expect(deps.changeExecutor).toHaveBeenCalledTimes(2)
    const first = vi.mocked(deps.changeExecutor).mock.calls[0][1].promptVariables as Record<string, unknown>
    const second = vi.mocked(deps.changeExecutor).mock.calls[1][1].promptVariables as Record<string, unknown>
    expect(first).not.toHaveProperty("previous_problems")
    expect(second.previous_problems).toContain('"Create, Update and Delete Projects"')
    expect(second.previous_problems).toContain("TÁCH")
    expect(result.changes[0]).toMatchObject({ path: "use_cases[id=UC05].name", value: "Find Project" })
  })

  it("FLF-243: lần gọi lại vẫn sai ⇒ không gọi thêm, giữ lô (cờ vàng là lưới cuối)", async () => {
    await seed()
    deps.changeExecutor = vi.fn(async () => aiResult({ ops: [{ op: "set", path: "use_cases[id=UC05].name", value: "Manage Projects" }] }))
    const result = await preview(PROJECT, USER, { base_version: 1, instruction: "Đổi tên UC05" }, {}, deps)
    expect(deps.changeExecutor).toHaveBeenCalledTimes(2)
    expect(result.changes[0]).toMatchObject({ value: "Manage Projects" })
  })

  it("FLF-243: user gõ nguyên văn tên ⇒ dùng như user muốn, không gọi lại; tên đúng luật cũng không gọi lại", async () => {
    await seed()
    deps.changeExecutor = vi.fn(async () => aiResult({ ops: [{ op: "set", path: "use_cases[id=UC05].name", value: "Manage Projects" }] }))
    await preview(PROJECT, USER, { base_version: 1, instruction: 'Đổi tên UC05 thành "Manage Projects"' }, {}, deps)
    expect(deps.changeExecutor).toHaveBeenCalledTimes(1)

    deps.changeExecutor = vi.fn(async () => aiResult({ ops: [{ op: "set", path: "use_cases[id=UC05].name", value: "Find Project" }] }))
    await preview(PROJECT, USER, { base_version: 1, instruction: "Đổi tên UC05" }, {}, deps)
    expect(deps.changeExecutor).toHaveBeenCalledTimes(1)
  })

  it("FLF-260: reply_language ⇒ lời gọi model mang replyLanguage (preview lẫn apply); không có ⇒ không có field", async () => {
    await seed()
    deps.changeExecutor = vi.fn(async () => aiResult({ ops: [{ op: "set", path: "actors[id=A01].name", value: "X" }] }))

    await preview(PROJECT, USER, { base_version: 1, instruction: "Rename A01 to X", reply_language: "en" }, {}, deps)
    await preview(PROJECT, USER, { base_version: 1, instruction: "Đổi tên A01 thành X" }, {}, deps)
    await apply(PROJECT, USER, { base_version: 1, instruction: "Rename A01 to X", reply_language: "en" }, {}, deps)

    const inputs = vi.mocked(deps.changeExecutor).mock.calls.map((call) => call[1])
    expect(inputs).toHaveLength(3)
    expect(inputs[0].replyLanguage).toBe("en")
    expect(inputs[1]).not.toHaveProperty("replyLanguage")
    expect(inputs[2].replyLanguage).toBe("en")
    // Ngôn ngữ đi khối "Reply language" cuối prompt (`buildPrompt`), không thêm biến template nào
    expect(Object.keys(inputs[0].promptVariables ?? {})).toEqual(Object.keys(inputs[1].promptVariables ?? {}))
  })

  it("FLF-260: output sai khuôn ở lượt tiếng Anh ⇒ câu hỏi lại tiếng Anh; không có reply_language ⇒ vẫn tiếng Việt", async () => {
    await seed()
    deps.changeExecutor = vi.fn(async () => {
      throw new AiActionError(422, "Failed to parse AI response for action 'change_instruction'", "PARSE_FAILED")
    })

    const english = await preview(PROJECT, USER, { base_version: 1, instruction: "Regenerate the ERD", reply_language: "en" }, {}, deps)
    expect(english.ok).toBe(false)
    expect(english.clarification).toMatch(/^I couldn't tell what to change in the document\./)
    // Giao diện chỉ có tiếng Việt ⇒ gọi nút đúng nhãn đang hiện, kèm chú thích tiếng Anh
    expect(english.clarification).toContain('"Vẽ lại sơ đồ" (Redraw diagram)')
    await expect(
      apply(PROJECT, USER, { base_version: 1, instruction: "Regenerate the ERD", reply_language: "en" }, {}, deps)
    ).rejects.toMatchObject({ code: "NEEDS_CLARIFICATION", clarification: english.clarification })

    const vietnamese = await preview(PROJECT, USER, { base_version: 1, instruction: "Vẽ lại ERD" }, {}, deps)
    expect(vietnamese.clarification).toMatch(/^Mình chưa xác định được cần đổi gì trong tài liệu\./)
    expect(vietnamese.clarification).toContain("Vẽ lại sơ đồ")
  })

  it("preview_id đã dùng rồi ⇒ 422 PREVIEW_EXPIRED", async () => {
    await seed()
    deps.changeExecutor = vi.fn(async () => aiResult({ ops: [{ op: "set", path: "actors[id=A01].name", value: "X" }] }))
    const previewed = await preview(PROJECT, USER, { base_version: 1, instruction: "Đổi tên A01" }, {}, deps)
    await apply(PROJECT, USER, { base_version: 1, preview_id: previewed.preview_id }, {}, deps)

    await expect(apply(PROJECT, USER, { base_version: 2, preview_id: previewed.preview_id }, {}, deps)).rejects.toMatchObject({
      statusCode: 422,
      code: "CHANGE_RANGE_INVALID"
    })
  })
})

describe("buildChangeProjection — brief_core ở pha Brief", () => {
  const entry = (id: string, topic: string) => ({ id, topic, content: "Nội dung", content_en: "Content", target_section: "fixed:1", captured_at: "2026-09-30T00:00:00.000Z" })
  const at = (phase: string): Spine => ({
    ...structuredClone(FIXTURE),
    addendum: [entry("AD1", "vision"), entry("AD2", "goals"), entry("AD5", "Why now")],
    progress: { ...FIXTURE.progress, current_phase: phase }
  })

  it("phase B-*: có brief_core gồm entry lõi (id, topic, content, content_en), cả khi câu lệnh nhắc thực thể lẫn không", () => {
    for (const instruction of ["làm cho tài liệu hay hơn", "Đổi tên actor A01 thành Product Owner"]) {
      expect(buildChangeProjection(at("B-1"), instruction).brief_core).toEqual([
        { id: "AD1", topic: "vision", content: "Nội dung", content_en: "Content" },
        { id: "AD2", topic: "goals", content: "Nội dung", content_en: "Content" }
      ])
    }
  })

  it("phase ngoài Brief: không có brief_core", () => {
    expect(buildChangeProjection(at("S-3"), "làm cho tài liệu hay hơn").brief_core).toBeUndefined()
  })
})

describe("lệnh chỉ ra cả một mục (\"Trong §3.1.5 …\") ⇒ model thấy đủ dữ liệu của mục", () => {
  it("§3.1.5 ERD không nhắc entity nào ⇒ mọi entity kèm quan hệ, động từ, bản số", () => {
    const projection = buildChangeProjection(FIXTURE, "Trong §3.1.5 Entity Relationship Diagram: vẽ lại")
    const entities = projection.entities as { id: string; relations: string[] }[]
    expect(entities.map((e) => e.id)).toEqual(FIXTURE.entities.map((e) => e.id))
    expect(entities.some((e) => e.relations.length > 0)).toBe(true)
  })

  it("nhắc cả mục lẫn một entity ⇒ vẫn đủ mục, không chỉ entity được nhắc", () => {
    const name = FIXTURE.entities[0].name
    const projection = buildChangeProjection(FIXTURE, `Trong §3.1.5 Entity Relationship Diagram: nối ${name} với entity khác`)
    expect((projection.entities as unknown[]).length).toBe(FIXTURE.entities.length)
  })

  it("FLF-248: mục được nhắc mà còn rỗng (§5.2) ⇒ projection có collection rỗng + đường add và field, không rơi về chỉ mục", () => {
    const bare = { ...FIXTURE, common_requirements: [] }
    const projection = buildChangeProjection(bare, "Trong §5.2 Common Requirements: thêm yêu cầu phân trang 20 dòng")
    expect(projection.common_requirements).toEqual([])
    expect(projection.empty_collections).toEqual({ common_requirements: { add_path: "common_requirements[]", fields: ["category", "statement"] } })
    // Không phải chỉ mục gọn {id,label} của mọi collection
    expect(projection.nfrs).toBeUndefined()
  })

  it("mục là sơ đồ ⇒ kèm dữ liệu sinh ra sơ đồ; số mục khớp nguyên số, không khớp tiền tố", () => {
    expect(sectionCollections("fixed:3.1.5")).toEqual(["entities"])
    expect(sectionCollections("fixed:2.2.1")).toEqual(expect.arrayContaining(["actors", "use_cases"]))
    expect(sectionCollections("fixed:3.1.1")).toContain("screens")
    expect(referencedSections("trong §3.1.5 entity relationship diagram: x")).toEqual(["fixed:3.1.5"])
    expect(referencedSections("trong §3.1 x")).not.toContain("fixed:3.1.5")
    expect(referencedSections("đổi tên actor a01")).toEqual([])
  })
})

describe("sửa phân quyền màn hình (§3.1.3) và output sai khuôn", () => {
  it("nhắc tên màn ⇒ projection có dòng permissions của đúng màn đó, kèm tên vai trò", () => {
    const projection = buildChangeProjection(FIXTURE, "Login chỉ cho Analyst và Admin view, xóa Guest")
    const rows = projection.permissions as { screen_id: string }[]
    expect(rows.length).toBe(FIXTURE.permissions.filter((p) => p.screen_id === "S01").length)
    expect(rows.every((p) => p.screen_id === "S01")).toBe(true)
    expect((projection.roles as { id: string; name: string }[]).map((r) => r.name)).toContain("Guest")
    expect((projection.existing_ids as Record<string, string[]>).permissions).toContain("P001")
  })

  it("chỉ nói §3.1.3 / phân quyền ⇒ mọi dòng permissions + danh sách màn và vai trò gọn", () => {
    const projection = buildChangeProjection(FIXTURE, "Sửa §3.1.3 Screen Authorization cho đúng")
    expect((projection.permissions as unknown[]).length).toBe(FIXTURE.permissions.length)
    expect((projection.screens as { id: string; name: string }[])[0]).toEqual({ id: "S01", name: "Login" })
    expect(buildChangeProjection(FIXTURE, "làm cho tài liệu hay hơn")).not.toHaveProperty("permissions")
  })

  it("lô sai schema (field không tồn tại) ⇒ gọi lại model MỘT lần kèm lỗi và cách ghi permissions[]", async () => {
    await seed()
    deps.changeExecutor = vi
      .fn()
      .mockResolvedValueOnce(aiResult({ ops: [{ op: "set", path: "screens[id=S01].authorized_role_ids", value: ["R1", "R2"] }] }))
      .mockResolvedValueOnce(aiResult({ ops: [{ op: "remove", path: "permissions[id=P001]" }] }))

    const result = await preview(PROJECT, USER, { base_version: 1, instruction: "Login xóa Guest" }, {}, deps)

    expect(deps.changeExecutor).toHaveBeenCalledTimes(2)
    const second = vi.mocked(deps.changeExecutor).mock.calls[1][1].promptVariables as Record<string, unknown>
    expect(second.previous_problems).toContain("authorized_role_ids")
    expect(second.previous_problems).toContain("permissions[]")
    expect(result.ok).toBe(true)
    expect(result.changes[0]).toMatchObject({ path: "permissions[id=P001]" })
  })

  it("model trả output sai khuôn (lỗi Zod) ⇒ preview hỏi lại bằng tiếng Việt, không ném lỗi kỹ thuật", async () => {
    await seed()
    deps.changeExecutor = vi.fn(async () => {
      throw new AiActionError(422, "AI response failed Zod schema validation for action 'change_instruction'", "SCHEMA_MISMATCH")
    })
    const result = await preview(PROJECT, USER, { base_version: 1, instruction: "Trong §3.1.5 Entity Relationship Diagram: gen lại" }, {}, deps)
    expect(result.ok).toBe(false)
    expect(result.clarification).toContain("Vẽ lại")
    expect(result.clarification).not.toMatch(/Zod|schema/i)
  })

  it("lỗi không phải do output của model (hết credit) vẫn ném thẳng", async () => {
    await seed()
    deps.changeExecutor = vi.fn(async () => {
      throw new AiActionError(402, "no credit", "INSUFFICIENT_CREDIT")
    })
    await expect(preview(PROJECT, USER, { base_version: 1, instruction: "Đổi tên A01" }, {}, deps)).rejects.toMatchObject({ code: "INSUFFICIENT_CREDIT" })
  })
})

describe("buildChangeProjection — chỉ thực thể được nhắc", () => {
  it("nhắc id ⇒ chỉ phần tử đó, không nạp cả Spine", () => {
    const projection = buildChangeProjection(FIXTURE, "Đổi tên actor A01 thành Product Owner")
    expect(projection.actors).toHaveLength(1)
    expect((projection.actors as { id: string }[])[0].id).toBe("A01")
    expect(projection.functions).toBeUndefined()
  })

  it("nhắc bằng tên ⇒ khớp theo name", () => {
    const projection = buildChangeProjection(FIXTURE, "Màn Login nên có tab ghi nhớ đăng nhập")
    expect((projection.screens as { id: string }[]).map((s) => s.id)).toContain("S01")
  })

  it("không nhắc ai rõ ràng ⇒ chỉ mục gọn (id + nhãn), không có mô tả", () => {
    const projection = buildChangeProjection(FIXTURE, "làm cho tài liệu hay hơn")
    const actors = projection.actors as { id: string; label: string }[]
    expect(actors.length).toBeGreaterThan(0)
    expect(Object.keys(actors[0])).toEqual(["id", "label"])
  })

  it("FLF-200 (BUG-08): luôn kèm danh sách id đang tồn tại để model không đoán id", () => {
    const focused = buildChangeProjection(FIXTURE, "Đổi tên actor A01 thành Product Owner")
    const ids = focused.existing_ids as Record<string, string[]>
    expect(ids.use_cases).toEqual(FIXTURE.use_cases.map((u) => u.id))
    expect(ids.actors).toContain("A01")

    const broad = buildChangeProjection(FIXTURE, "làm cho tài liệu hay hơn")
    expect((broad.existing_ids as Record<string, string[]>).screens).toContain("S01")
  })
})

// ─── apply ───────────────────────────────────────────────────────

describe("apply — ghi Spine, section phụ thuộc thành stale", () => {
  it("đổi tên actor: ghi changes[], recompute cờ, fixed:2.2.2 thành stale", async () => {
    await seed()
    const applied = await apply(PROJECT, USER, { base_version: 1, ops: [{ op: "set", path: "actors[id=A01].name", value: "Product Owner" }] }, {}, deps)

    expect(applied.spine_version).toBe(2)
    expect(applied.branch).toBe("dependent")
    expect(applied.changes).toHaveLength(1)
    expect(deps.recomputeFlags).toHaveBeenCalledWith(PROJECT, USER)

    const record = await repo.get(PROJECT)
    const changes = await repo.listChanges(PROJECT)
    expect(computeStatus({ ...record! }, changes, "fixed:2.2.2")).toBe("stale")
    expect(computeStatus({ ...record! }, changes, "fixed:3.1.3")).toBe("stale")
  })

  it("lô không đổi gì ⇒ txn null, version giữ nguyên, không recompute", async () => {
    await seed()
    const applied = await apply(PROJECT, USER, { base_version: 1, ops: [{ op: "set", path: "actors[id=A01].name", value: "Founder" }] }, {}, deps)

    expect(applied.txn).toBeNull()
    expect(applied.spine_version).toBe(1)
    expect(deps.recomputeFlags).not.toHaveBeenCalled()
  })

  it("gốc hệ thống quản lý ⇒ 422 OP_INVALID path_not_writable", async () => {
    await seed()
    await expect(
      apply(PROJECT, USER, { base_version: 1, ops: [{ op: "set", path: "steps[id=S-3.1].status", value: "pending" }] }, {}, deps)
    ).rejects.toBeInstanceOf(TransactionRejectedError)
  })

  it("lô phá bất biến ⇒ TransactionRejectedError, không ghi", async () => {
    await seed()
    await expect(
      apply(PROJECT, USER, { base_version: 1, ops: [{ op: "set", path: "screens[id=S01].feature_id", value: "F999" }] }, {}, deps)
    ).rejects.toMatchObject({ statusCode: 422, code: "INVARIANT_VIOLATION" })
    expect(await writtenChanges()).toBe(0)
  })
})

describe("apply sau baseline — reason bắt buộc, impact luôn có", () => {
  const withBaseline = (): Spine => {
    const spine = structuredClone(FIXTURE)
    spine.baselines = [
      { id: "B1", version: "v1.0", type: "generated", doc_version: null, at: "2026-09-10T00:00:00.000Z", snapshot_ref: "650000000000000000000099", checked_at_version: 1, waived_count: 0 }
    ]
    return spine
  }

  it("thiếu reason ⇒ 400, không ghi gì", async () => {
    await seed(withBaseline())
    await expect(
      apply(PROJECT, USER, { base_version: 1, ops: [{ op: "set", path: "project.vision", value: "Tầm nhìn mới" }] }, {}, deps)
    ).rejects.toMatchObject({ statusCode: 400, code: "VALIDATION_ERROR" })
    expect(await writtenChanges()).toBe(0)
  })

  it("có reason ⇒ áp được, branch post_baseline, impact trong kết quả, reason vào changes[]", async () => {
    await seed(withBaseline())
    const applied = await apply(
      PROJECT,
      USER,
      { base_version: 1, ops: [{ op: "set", path: "project.vision", value: "Tầm nhìn mới" }], reason: "Khách hàng đổi mục tiêu" },
      {},
      deps
    )

    expect(applied.branch).toBe("post_baseline")
    expect(applied.impact.sections.map((s) => s.id)).toContain("fixed:1")
    expect(applied.changes[0].reason).toBe("Khách hàng đổi mục tiêu")
  })

  it("preview sau baseline cũng báo nhánh post_baseline", async () => {
    await seed(withBaseline())
    const result = await preview(PROJECT, USER, { base_version: 1, ops: [{ op: "set", path: "project.vision", value: "x" }] }, {}, deps)
    expect(result.branch).toBe("post_baseline")
    expect(result.impact).toBeDefined()
  })
})

describe("isChangeInstruction — nhận lệnh sửa trong chat thường", () => {
  it.each([
    "Đổi tên actor A01 thành Product Owner",
    "Xoá màn hình S07",
    "Thêm một use case cho admin",
    "Cập nhật mô tả của FN001",
    "Rename the Admin actor to Administrator",
    "remove screen S07"
  ])("nhận: %s", (message) => {
    expect(isChangeInstruction(message)).toBe(true)
  })

  it.each([
    "Tài liệu này đang thiếu gì?",
    "Tại sao section 3.1.3 lại stale",
    "Use case UC02 nghĩa là gì",
    "Tôi đang nghĩ có nên đổi tên actor không",
    "What should I change next",
    ""
  ])("không nhận: %s", (message) => {
    expect(isChangeInstruction(message)).toBe(false)
  })

  it("động từ nằm quá xa đầu câu ⇒ không nhận (tránh nhận nhầm câu kể)", () => {
    expect(isChangeInstruction("Theo tôi thì phần này có lẽ nên đổi tên lại cho gọn")).toBe(false)
  })

  it("FLF-260: từ hỏi tiếng Anh khớp nguyên từ — \"how\" trong \"showing\" không chặn lệnh; câu hỏi thật vẫn chặn", () => {
    expect(isChangeInstruction("Add a field showing the order status")).toBe(true)
    expect(isChangeInstruction("Update the dashboard so it shows overdue tasks")).toBe(true)
    expect(isChangeInstruction("How does this work?")).toBe(false)
    // Không có "?": chặn nhờ chính từ hỏi, dù "add" nằm trong cửa sổ động từ
    expect(isChangeInstruction("How do I add a new screen")).toBe(false)
    expect(isChangeInstruction("why delete UC02")).toBe(false)
  })

  it.each([
    "Create a use case for refunds",
    "Edit the description of FN001",
    "Modify screen S07 to add a search box",
    "Insert a step after login",
    "Please create a reminder screen"
  ])("FLF-260: động từ tiếng Anh create/edit/modify/insert ở đầu câu ⇒ nhận: %s", (message) => {
    expect(isChangeInstruction(message)).toBe(true)
  })

  it.each([
    "Màn Create Order có những trường nào",
    "Màn edit profile gồm những gì",
    "Có cần create account không",
    "Mình muốn hỏi: create user ở đâu"
  ])("FLF-260: câu hỏi tiếng Việt nhắc tên phần tử tiếng Anh ⇒ vẫn là chat, không tốn lượt sửa: %s", (message) => {
    expect(isChangeInstruction(message)).toBe(false)
  })
})
