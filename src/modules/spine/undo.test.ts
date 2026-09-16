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
import type { Spine, Change as SpineChange } from "./spine.types.js"
import * as repo from "./spine.repository.js"
import { applyTransaction } from "./op-engine.js"
import { findUndoTarget, undoLast } from "./undo.service.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE: Spine = spineSchema.parse(
  JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/spine-fixture-19-screens.json"), "utf8"))
)

const PROJECT = "650000000000000000000001"
const USER = "650000000000000000000010"

const seed = async (spine: Spine = FIXTURE): Promise<void> => {
  await repo.getOrCreate(PROJECT)
  db.spines[0] = { _id: "spine", projectId: PROJECT, ...structuredClone(spine) }
}

/** Bỏ `spine_version` (mỗi txn tăng) và `projectId` (chỉ có ở bản đọc từ repository) để so deep-equal. */
const comparable = (spine: Spine | (Spine & { projectId: string })): Omit<Spine, "spine_version"> => {
  const { spine_version: _v, ...rest } = spine as Spine & { projectId?: string }
  delete rest.projectId
  return rest
}

const change = (over: Partial<SpineChange> & Pick<SpineChange, "seq" | "txn" | "path">): SpineChange => ({
  projectId: PROJECT,
  op: "set",
  before: null,
  value: null,
  reason: null,
  at: "2026-09-16T00:00:00.000Z",
  by: USER,
  step_id: null,
  ...over
})

describe("findUndoTarget — chọn lô nào để hoàn tác", () => {
  it("lô người dùng gần nhất", () => {
    const target = findUndoTarget([
      change({ seq: 1, txn: "T1", path: "actors[id=A01].name" }),
      change({ seq: 2, txn: "T2", path: "use_cases[id=UC01].name" }),
      change({ seq: 3, txn: "T2", path: "use_cases[id=UC01].description" })
    ])
    expect(target).toEqual({ txn: "T2", first_seq: 2, last_seq: 3 })
  })

  it("bỏ qua lô render (diagrams) và baseline", () => {
    const target = findUndoTarget([
      change({ seq: 1, txn: "T1", path: "actors[id=A01].name" }),
      change({ seq: 2, txn: "R1", path: "diagrams[id=D02].puml" }),
      change({ seq: 3, txn: "B1", path: "baselines[]" })
    ])
    expect(target?.txn).toBe("T1")
  })

  it("bỏ qua lô recompute cờ (chỉ chạm flags[])", () => {
    const target = findUndoTarget([
      change({ seq: 1, txn: "T1", path: "actors[id=A01].name" }),
      change({ seq: 2, txn: "F1", path: "flags[]" })
    ])
    expect(target?.txn).toBe("T1")
  })

  it("lô đã bị undo và chính lô undo đều bị loại ⇒ undo hai lần đi lùi đúng thứ tự", () => {
    const history = [
      change({ seq: 1, txn: "T1", path: "actors[id=A01].name" }),
      change({ seq: 2, txn: "T2", path: "use_cases[id=UC01].name" })
    ]
    expect(findUndoTarget(history)?.txn).toBe("T2")

    const afterFirstUndo = [
      ...history,
      change({ seq: 3, txn: "U1", op: "revert", path: "use_cases[id=UC01].name", reason: "Revert seq 2" })
    ]
    expect(findUndoTarget(afterFirstUndo)?.txn).toBe("T1")

    const afterSecondUndo = [
      ...afterFirstUndo,
      change({ seq: 4, txn: "U2", op: "revert", path: "actors[id=A01].name", reason: "Revert seq 1" })
    ]
    expect(findUndoTarget(afterSecondUndo)).toBeNull()
  })

  it("lịch sử rỗng ⇒ null", () => {
    expect(findUndoTarget([])).toBeNull()
  })
})

describe("undoLast — khôi phục Spine", () => {
  beforeEach(() => db.reset())

  it("khôi phục Spine deep-equal trạng thái trước lô", async () => {
    await seed()
    const before = comparable(structuredClone(FIXTURE))

    const applied = await applyTransaction(PROJECT, {
      base_version: 1,
      by: USER,
      ops: [
        { op: "set", path: "actors[id=A01].name", value: "Product Owner" },
        { op: "set", path: "actors[id=A01].description", value: "Đổi mô tả cùng lô" }
      ]
    })
    expect(applied.spine_version).toBe(2)

    const undone = await undoLast(PROJECT, USER, { base_version: 2 })
    expect(undone.spine_version).toBe(3)
    expect(comparable(undone.spine)).toEqual(before)
    expect(undone.changes.every((c) => c.op === "revert")).toBe(true)
  })

  it("undo hai lần liên tiếp đi lùi đúng thứ tự", async () => {
    await seed()
    const before = comparable(structuredClone(FIXTURE))

    await applyTransaction(PROJECT, { base_version: 1, by: USER, ops: [{ op: "set", path: "actors[id=A01].name", value: "B1" }] })
    await applyTransaction(PROJECT, { base_version: 2, by: USER, ops: [{ op: "set", path: "use_cases[id=UC01].name", value: "B2" }] })

    const first = await undoLast(PROJECT, USER, { base_version: 3 })
    expect(first.spine.use_cases.find((u) => u.id === "UC01")?.name).toBe("Register Account")
    expect(first.spine.actors.find((a) => a.id === "A01")?.name).toBe("B1")

    const second = await undoLast(PROJECT, USER, { base_version: first.spine_version })
    expect(comparable(second.spine)).toEqual(before)

    await expect(undoLast(PROJECT, USER, { base_version: second.spine_version })).rejects.toMatchObject({
      statusCode: 422,
      code: "NOTHING_TO_UNDO"
    })
  })

  it("khôi phục được cả lô có cascade (xoá actor kéo theo use_cases[].actor_ids)", async () => {
    await seed()
    const before = comparable(structuredClone(FIXTURE))

    const applied = await applyTransaction(PROJECT, { base_version: 1, by: USER, ops: [{ op: "remove", path: "actors[id=A08]" }] })
    expect(applied.changes.length).toBeGreaterThan(1)

    const undone = await undoLast(PROJECT, USER, { base_version: applied.spine_version })
    expect(comparable(undone.spine)).toEqual(before)
  })

  it("base_version lệch ⇒ 409 SPINE_VERSION_CONFLICT, không ghi gì", async () => {
    await seed()
    await applyTransaction(PROJECT, { base_version: 1, by: USER, ops: [{ op: "set", path: "actors[id=A01].name", value: "X" }] })
    const seqBefore = await repo.nextSeq(PROJECT)

    await expect(undoLast(PROJECT, USER, { base_version: 1 })).rejects.toMatchObject({
      statusCode: 409,
      code: "SPINE_VERSION_CONFLICT"
    })
    expect(await repo.nextSeq(PROJECT)).toBe(seqBefore)
  })

  it("project chưa có thay đổi nào ⇒ 422 NOTHING_TO_UNDO", async () => {
    await seed()
    await expect(undoLast(PROJECT, USER, { base_version: 1 })).rejects.toMatchObject({ code: "NOTHING_TO_UNDO" })
  })
})
