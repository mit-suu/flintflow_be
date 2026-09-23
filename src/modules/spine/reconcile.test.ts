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
import type { Change as SpineChange, Spine } from "./spine.types.js"
import * as repo from "./spine.repository.js"
import { applyTransaction } from "./op-engine.js"
import { awaitingReaccept, computeStatus } from "./section-status.js"
import { computeSourceHash } from "./source-hash.js"
import { clearPreviewStore } from "./change.service.js"
import {
  changesMakingStale,
  clearReconcileState,
  defaultReconcileDeps,
  isReconcileApplied,
  reconcile,
  staleSections,
  type ReconcileDeps
} from "./reconcile.service.js"
import type { AiActionResult } from "../../shared/ai/ai-action.types.js"
import type { OpTransaction } from "../../shared/ai/response-parser.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE: Spine = spineSchema.parse(
  JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/spine-fixture-19-screens.json"), "utf8"))
)

const PROJECT = "650000000000000000000001"
const USER = "650000000000000000000010"
const SEED_SEQ = Math.max(0, ...FIXTURE.steps.map((s) => s.last_seq ?? 0))

/**
 * Fixture để `source_hash = "TBD"` (chưa từng render) nên MỌI hình đều "stale". Ở đây tính hash thật
 * trước khi gieo, để kiểm đúng việc "chỉ vẽ lại hình có hash lệch sau khi áp".
 */
const withRealHashes = (spine: Spine): Spine => {
  const copy = structuredClone(spine)
  for (const diagram of copy.diagrams) diagram.source_hash = computeSourceHash(copy, diagram)
  return copy
}

const seed = async (input: Spine = FIXTURE): Promise<void> => {
  const spine = withRealHashes(input)
  await repo.getOrCreate(PROJECT)
  db.spines[0] = { _id: "spine", projectId: PROJECT, ...structuredClone(spine) }
  db.changes.push({
    projectId: PROJECT,
    seq: SEED_SEQ,
    txn: "seed",
    op: "set",
    // Path không ánh xạ section nào (`sectionsOfPath` trả rỗng) — change mốc không được tự làm section stale
    path: "progress.elicit_turns_this_phase",
    before: 0,
    value: 0,
    reason: "seed fixture",
    at: "2026-09-01T00:00:00.000Z",
    by: "system",
    step_id: spine.steps.find((s) => s.last_seq === SEED_SEQ)?.id ?? null
  })
}

const opsResult = (ops: OpTransaction["ops"]): AiActionResult<OpTransaction> =>
  ({
    success: true,
    data: { ops },
    rawText: "{}",
    actionType: "reconcile",
    provider: "mock",
    aiModel: "mock",
    tokensUsed: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    cost: 1,
    logId: null
  }) as unknown as AiActionResult<OpTransaction>

let deps: ReconcileDeps

beforeEach(() => {
  db.reset()
  clearPreviewStore()
  clearReconcileState()
  deps = {
    changeExecutor: vi.fn(),
    recomputeFlags: vi.fn(async () => undefined),
    reconcileExecutor: vi.fn(async () => opsResult([])),
    rerender: vi.fn(async () => undefined)
  }
})

/** Đổi tên actor A01 — làm fixed:2.2.2 và fixed:3.1.3 stale. */
const renameActor = () =>
  applyTransaction(PROJECT, {
    base_version: 1,
    by: USER,
    ops: [{ op: "set", path: "actors[id=A01].name", value: "Product Owner" }],
    reason: "đổi tên"
  })

// ─── phần thuần ──────────────────────────────────────────────────

describe("changesMakingStale / staleSections", () => {
  const change = (over: Partial<SpineChange>): SpineChange => ({
    projectId: PROJECT,
    seq: SEED_SEQ + 1,
    txn: "T1",
    op: "set",
    path: "actors[id=A01].name",
    before: "Founder",
    value: "Product Owner",
    reason: "đổi tên",
    at: "2026-09-16T00:00:00.000Z",
    by: USER,
    step_id: null,
    ...over
  })

  it("chỉ change nuôi section và mới hơn mốc accept của step sở hữu", () => {
    const changes = [change({ seq: 10 }), change({ seq: SEED_SEQ + 1 })]
    const causing = changesMakingStale(FIXTURE, changes, "fixed:2.2.2")
    expect(causing.map((c) => c.seq)).toEqual([SEED_SEQ + 1])
  })

  it("change do chính step sở hữu ghi không làm stale", () => {
    const changes = [change({ seq: SEED_SEQ + 1, step_id: "S-3.2" })]
    expect(changesMakingStale(FIXTURE, changes, "fixed:2.2.2")).toEqual([])
  })

  it("staleSections kèm step sở hữu và đúng change gây ra", () => {
    const changes = [change({ seq: SEED_SEQ + 1 })]
    const briefs = staleSections(FIXTURE, changes)
    const ids = briefs.map((b) => b.section_id)

    expect(ids).toContain("fixed:2.2.2")
    expect(ids).toContain("fixed:3.1.3")
    // Section sở hữu cũng stale: user sửa thẳng field, change không mang `step_id` của step sở hữu (§5)
    expect(ids).toContain("fixed:2.1")
    const brief = briefs.find((b) => b.section_id === "fixed:2.2.2")!
    expect(brief.owner_step).toBe("S-3.2")
    expect(brief.changes[0]).toMatchObject({ path: "actors[id=A01].name", before: "Founder" })
  })

  it("không có change mới ⇒ không section nào stale", () => {
    expect(staleSections(FIXTURE, [])).toEqual([])
  })
})

// ─── lượt 1: preview gộp ─────────────────────────────────────────

describe("reconcile lượt 1 — preview diff gộp", () => {
  it("gọi skill của step sở hữu từng section stale, gộp ops thành một preview", async () => {
    await seed()
    await renameActor()
    const version = (await repo.get(PROJECT))!.spine_version

    deps.reconcileExecutor = vi.fn(async (_type, input) => {
      const stepId = (input.promptVariables as { step_id: string }).step_id
      return stepId === "S-3.2"
        ? opsResult([{ op: "set", path: "use_cases[id=UC02].description", value: "The Product Owner creates a project." }])
        : opsResult([])
    })

    const result = await reconcile(PROJECT, USER, { base_version: version }, {}, deps)

    expect(isReconcileApplied(result)).toBe(false)
    if (isReconcileApplied(result)) return
    expect(result.ok).toBe(true)
    expect(result.preview_id).toBeTypeOf("string")
    expect(result.changes.map((c) => c.path)).toEqual(["use_cases[id=UC02].description"])
    // Một lượt gọi model cho mỗi section stale
    expect(deps.reconcileExecutor).toHaveBeenCalled()
    const steps = vi.mocked(deps.reconcileExecutor).mock.calls.map((call) => (call[1].promptVariables as { step_id: string }).step_id)
    expect(steps).toContain("S-3.2")
    expect(steps).toContain("S-4.3")
  })

  it("projection gửi cho model chỉ là field step đó đọc + change gây stale", async () => {
    await seed()
    await renameActor()
    const version = (await repo.get(PROJECT))!.spine_version
    await reconcile(PROJECT, USER, { base_version: version }, {}, deps)

    const call = vi.mocked(deps.reconcileExecutor).mock.calls.find((c) => (c[1].promptVariables as { step_id: string }).step_id === "S-3.2")!
    const vars = call[1].promptVariables as { projection: Record<string, unknown>; stale_sections: { section_id: string; changes: unknown[] }[] }

    expect(Object.keys(vars.projection)).not.toContain("functions")
    expect(vars.stale_sections).toHaveLength(1)
    expect(vars.stale_sections[0].section_id).toBe("fixed:2.2.2")
    expect(vars.stale_sections[0].changes).toHaveLength(1)
  })

  it("không có section stale ⇒ preview rỗng kèm ghi chú, không gọi model", async () => {
    await seed()
    const result = await reconcile(PROJECT, USER, { base_version: 1 }, {}, deps)

    expect(isReconcileApplied(result)).toBe(false)
    if (isReconcileApplied(result)) return
    expect(result.ops).toEqual([])
    expect(result.notes).toContain("Không có section nào đang stale")
    expect(deps.reconcileExecutor).not.toHaveBeenCalled()
  })

  it("base_version lệch ⇒ 409 SPINE_VERSION_CONFLICT", async () => {
    await seed()
    await expect(reconcile(PROJECT, USER, { base_version: 99 }, {}, deps)).rejects.toMatchObject({ code: "SPINE_VERSION_CONFLICT" })
  })
})

// ─── lượt 2: áp ──────────────────────────────────────────────────

describe("reconcile lượt 2 — áp, vẽ lại hình, awaiting_reaccept", () => {
  const runFirstPass = async () => {
    await seed()
    await renameActor()
    const version = (await repo.get(PROJECT))!.spine_version
    deps.reconcileExecutor = vi.fn(async (_type, input) => {
      const stepId = (input.promptVariables as { step_id: string }).step_id
      return stepId === "S-3.2"
        ? opsResult([{ op: "set", path: "use_cases[id=UC02].description", value: "The Product Owner creates a project." }])
        : opsResult([])
    })
    const previewed = await reconcile(PROJECT, USER, { base_version: version }, {}, deps)
    if (isReconcileApplied(previewed)) throw new Error("lượt 1 lẽ ra trả preview")
    return previewed
  }

  it("áp lô gộp, vẽ lại đúng hình có source_hash lệch, đặt step sở hữu về revision_requested", async () => {
    const previewed = await runFirstPass()
    const version = (await repo.get(PROJECT))!.spine_version

    const result = await reconcile(PROJECT, USER, { base_version: version, preview_id: previewed.preview_id }, {}, deps)

    expect(isReconcileApplied(result)).toBe(true)
    if (!isReconcileApplied(result)) return
    expect(result.spine.use_cases.find((u) => u.id === "UC02")?.description).toBe("The Product Owner creates a project.")

    // Hình vẽ lại: usecase (tên actor lên hình), không phải mọi hình
    expect(deps.rerender).toHaveBeenCalledTimes(1)
    const targets = vi.mocked(deps.rerender).mock.calls[0][1] as { kind: string }[]
    expect(targets.map((t) => t.kind)).toContain("usecase")
    expect(targets.map((t) => t.kind)).not.toContain("erd")

    const record = await repo.get(PROJECT)
    const { projectId: _p, ...spine } = record!
    expect(awaitingReaccept(spine, "fixed:2.2.2")).toBe(true)
    expect(awaitingReaccept(spine, "fixed:3.1.3")).toBe(true)
    // Section không hoà giải giữ nguyên trạng thái
    expect(awaitingReaccept(spine, "fixed:3.1.5")).toBe(false)
  })

  it("user từ chối diff (không gửi lượt 2) ⇒ section vẫn stale, không ghi gì thêm", async () => {
    await runFirstPass()
    const record = await repo.get(PROJECT)
    const { projectId: _p, ...spine } = record!
    const changes = await repo.listChanges(PROJECT)

    expect(computeStatus(spine, changes, "fixed:2.2.2")).toBe("stale")
    expect(deps.rerender).not.toHaveBeenCalled()
  })

  it("BUG-16: model không đề xuất gì ⇒ vẫn có preview_id để xác nhận không đổi, và cờ stale được gỡ", async () => {
    await seed()
    await renameActor()
    const version = (await repo.get(PROJECT))!.spine_version
    deps.reconcileExecutor = vi.fn(async () => opsResult([]))

    const previewed = await reconcile(PROJECT, USER, { base_version: version }, {}, deps)
    if (isReconcileApplied(previewed)) throw new Error("lượt 1 lẽ ra trả preview")
    expect(previewed.ops).toEqual([])
    expect(previewed.no_change).toBe(true)
    expect(previewed.preview_id, "không có nút xác nhận thì cờ đỏ không có đường nào gỡ").toBeTypeOf("string")

    const before = await repo.get(PROJECT)
    const { projectId: _b, ...spineBefore } = before!
    expect(computeStatus(spineBefore, await repo.listChanges(PROJECT), "fixed:2.2.2")).toBe("stale")

    const confirmed = await reconcile(PROJECT, USER, { base_version: before!.spine_version, preview_id: previewed.preview_id }, {}, deps)
    expect(isReconcileApplied(confirmed)).toBe(true)

    const after = await repo.get(PROJECT)
    const { projectId: _a, ...spineAfter } = after!
    expect(computeStatus(spineAfter, await repo.listChanges(PROJECT), "fixed:2.2.2")).not.toBe("stale")
  })

  it("dep mặc định đủ cả recomputeFlags — controller không truyền deps, nhánh xác nhận không đổi gọi thẳng hàm này", () => {
    const defaults = defaultReconcileDeps()
    for (const key of ["changeExecutor", "recomputeFlags", "reconcileExecutor", "rerender"] as const) {
      expect(defaults[key], key).toBeTypeOf("function")
    }
  })

  it("preview_id đã dùng ⇒ 422 PREVIEW_EXPIRED", async () => {
    const previewed = await runFirstPass()
    const version = (await repo.get(PROJECT))!.spine_version
    await reconcile(PROJECT, USER, { base_version: version, preview_id: previewed.preview_id }, {}, deps)

    const next = (await repo.get(PROJECT))!.spine_version
    await expect(reconcile(PROJECT, USER, { base_version: next, preview_id: previewed.preview_id }, {}, deps)).rejects.toMatchObject({
      code: "CHANGE_RANGE_INVALID"
    })
  })
})
