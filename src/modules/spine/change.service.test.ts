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
  type ChangeDeps
} from "./change.service.js"
import type { AiActionResult } from "../../shared/ai/ai-action.types.js"
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
    expect(result.clarification).toBe("Bạn muốn đổi actor nào — A01 hay A03?")
    expect(result.changes).toHaveLength(0)

    await expect(apply(PROJECT, USER, { base_version: 1, instruction: "đổi tên admin" }, {}, deps)).rejects.toBeInstanceOf(NeedsClarificationError)
  })

  it("apply với preview_id dùng lại lô đã xem, không gọi model lần hai", async () => {
    await seed()
    deps.changeExecutor = vi.fn(async () => aiResult({ ops: [{ op: "set", path: "actors[id=A01].name", value: "Product Owner" }] }))

    const previewed = await preview(PROJECT, USER, { base_version: 1, instruction: "Đổi tên A01" }, {}, deps)
    const applied = await apply(PROJECT, USER, { base_version: 1, instruction: "Đổi tên A01", preview_id: previewed.preview_id }, {}, deps)

    expect(deps.changeExecutor).toHaveBeenCalledTimes(1)
    expect(applied.spine.actors.find((a) => a.id === "A01")?.name).toBe("Product Owner")
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
})
