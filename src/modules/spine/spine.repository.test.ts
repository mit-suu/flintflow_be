import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * Model Mongoose được thay bằng store trong bộ nhớ mô phỏng đúng ngữ nghĩa
 * repository dựa vào: filter bằng nhau/khoảng, `findOneAndUpdate` nguyên tử
 * với `$set`/`$setOnInsert`/upsert, unique `(projectId, seq)`.
 * Chưa có mongodb-memory-server trong dependency — test tích hợp Mongo thật ở T22.
 */
const db = vi.hoisted(() => {
  type Doc = Record<string, unknown>
  type Filter = Record<string, unknown>
  type Range = { $gte?: number; $lte?: number }

  const spines: Doc[] = []
  const changes: Doc[] = []

  const isRange = (v: unknown): v is Range =>
    typeof v === "object" && v !== null && ("$gte" in v || "$lte" in v)

  const matches = (doc: Doc, filter: Filter): boolean =>
    Object.entries(filter).every(([key, expected]) => {
      const actual = doc[key]
      if (isRange(expected)) {
        const n = Number(actual)
        return (expected.$gte === undefined || n >= expected.$gte) && (expected.$lte === undefined || n <= expected.$lte)
      }
      return String(actual) === String(expected)
    })

  const copy = <X>(x: X): X => structuredClone(x)
  const bySeq = (a: Doc, b: Doc) => Number(a.seq) - Number(b.seq)
  const duplicateKey = (): Error => Object.assign(new Error("E11000 duplicate key error"), { code: 11000 })

  const Spine = {
    findOne: async (filter: Filter) => {
      const doc = spines.find((s) => matches(s, filter))
      return doc ? copy(doc) : null
    },
    exists: async (filter: Filter) => (spines.some((s) => matches(s, filter)) ? { _id: "exists" } : null),
    // Thân hàm chạy đồng bộ tới return ⇒ nguyên tử như Mongo
    findOneAndUpdate: async (
      filter: Filter,
      update: { $set?: Doc; $setOnInsert?: Doc },
      options: { upsert?: boolean } = {}
    ) => {
      const doc = spines.find((s) => matches(s, filter))
      if (doc) {
        Object.assign(doc, copy(update.$set ?? {}))
        return copy(doc)
      }
      if (!options.upsert) return null
      const created: Doc = {
        _id: `spine-${spines.length + 1}`,
        __v: 0,
        createdAt: new Date(),
        ...filter,
        ...copy(update.$setOnInsert ?? {}),
        ...copy(update.$set ?? {})
      }
      spines.push(created)
      return copy(created)
    }
  }

  const Change = {
    findOne: async (filter: Filter, _projection: unknown, options: { sort?: { seq?: number } } = {}) => {
      const rows = changes.filter((c) => matches(c, filter)).sort(bySeq)
      const row = options.sort?.seq === -1 ? rows[rows.length - 1] : rows[0]
      return row ? copy(row) : null
    },
    find: async (filter: Filter) => changes.filter((c) => matches(c, filter)).sort(bySeq).map(copy),
    insertMany: async (docs: Doc[]) => {
      const taken = (d: Doc) =>
        changes.some((c) => String(c.projectId) === String(d.projectId) && c.seq === d.seq)
      if (docs.some(taken)) throw duplicateKey()
      const rows = docs.map((d, i) => ({ _id: `change-${changes.length + i + 1}`, __v: 0, ...copy(d) }))
      changes.push(...rows)
      return rows.map(copy)
    }
  }

  const reset = () => {
    spines.length = 0
    changes.length = 0
  }

  return { Spine, Change, reset, duplicateKey }
})

vi.mock("./spine.model.js", () => ({ Spine: db.Spine }))
vi.mock("./change.model.js", () => ({ Change: db.Change }))

import * as repo from "./spine.repository.js"

const PROJECT = "650000000000000000000001"
const OTHER_PROJECT = "650000000000000000000002"

const change = (seq: number, overrides: Partial<repo.NewChange> = {}): repo.NewChange => ({
  seq,
  txn: "txn-1",
  op: "set",
  path: `actors[id=A0${seq}].name`,
  before: null,
  value: `Actor ${seq}`,
  reason: null,
  at: "2026-09-14T08:00:00.000Z",
  by: "650000000000000000000099",
  step_id: "S-2.1",
  ...overrides
})

beforeEach(() => {
  db.reset()
  vi.restoreAllMocks()
})

describe("getOrCreate / get", () => {
  it("tạo Spine rỗng version 1, seed name/domain, và không ghi đè khi gọi lại", async () => {
    expect(await repo.get(PROJECT)).toBeNull()

    const created = await repo.getOrCreate(PROJECT, { name: "Lumen", domain: "E-learning" })
    expect(created).toMatchObject({
      projectId: PROJECT,
      spine_version: 1,
      project: { name: "Lumen", domain: "E-learning" },
      progress: { current_phase: "B-0", current_step: "B-0.1" }
    })

    const saved = await repo.saveWithVersion({ ...created, project: { ...created.project, vision: "V" } }, 1)
    const again = await repo.getOrCreate(PROJECT, { name: "Tên khác" })
    expect(again).toEqual(saved)
    expect(again.project.name).toBe("Lumen")
  })

  it("upsert đồng thời dính unique index thì đọc lại bản đã tạo", async () => {
    await repo.getOrCreate(PROJECT)
    vi.spyOn(db.Spine, "findOneAndUpdate").mockRejectedValueOnce(db.duplicateKey())

    const spine = await repo.getOrCreate(PROJECT)
    expect(spine.projectId).toBe(PROJECT)
  })
})

describe("saveWithVersion — khoá lạc quan", () => {
  it("ghi khi base khớp và tăng spine_version đúng 1", async () => {
    const spine = await repo.getOrCreate(PROJECT)
    spine.actors.push({ id: "A01", name: "Student", kind: "human", description: "" })

    const saved = await repo.saveWithVersion(spine, 1)
    expect(saved.spine_version).toBe(2)
    expect((await repo.get(PROJECT))?.actors).toHaveLength(1)
  })

  it("base cũ ⇒ 409 SPINE_VERSION_CONFLICT", async () => {
    const spine = await repo.getOrCreate(PROJECT)
    await repo.saveWithVersion(spine, 1)

    await expect(repo.saveWithVersion(spine, 1)).rejects.toMatchObject({
      statusCode: 409,
      code: repo.SPINE_VERSION_CONFLICT
    })
  })

  it("hai saveWithVersion cùng base: đúng một thành công, một 409", async () => {
    const spine = await repo.getOrCreate(PROJECT)
    const tabA = { ...spine, project: { ...spine.project, vision: "Tab A" } }
    const tabB = { ...spine, project: { ...spine.project, vision: "Tab B" } }

    const results = await Promise.allSettled([repo.saveWithVersion(tabA, 1), repo.saveWithVersion(tabB, 1)])

    const fulfilled = results.filter((r) => r.status === "fulfilled")
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected")
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toMatchObject({ statusCode: 409, code: repo.SPINE_VERSION_CONFLICT })

    const current = await repo.get(PROJECT)
    expect(current?.spine_version).toBe(2)
    expect(current?.project.vision).toBe("Tab A")
  })

  it("project chưa có Spine ⇒ 404 SPINE_NOT_FOUND", async () => {
    const spine = await repo.getOrCreate(PROJECT)
    await expect(repo.saveWithVersion({ ...spine, projectId: OTHER_PROJECT }, 1)).rejects.toMatchObject({
      statusCode: 404,
      code: repo.SPINE_NOT_FOUND
    })
  })

  it("nội dung sai schema ⇒ 422 và DB không đổi", async () => {
    const spine = await repo.getOrCreate(PROJECT)
    spine.actors.push({ id: "A01", name: "Bot", kind: "robot" as never, description: "" })

    await expect(repo.saveWithVersion(spine, 1)).rejects.toMatchObject({
      statusCode: 422,
      code: repo.SPINE_SCHEMA_INVALID
    })
    const current = await repo.get(PROJECT)
    expect(current?.spine_version).toBe(1)
    expect(current?.actors).toEqual([])
  })
})

describe("changes", () => {
  it("nextSeq bắt đầu từ 1 và liên tục qua các lô", async () => {
    expect(await repo.nextSeq(PROJECT)).toBe(1)

    await repo.appendChanges(PROJECT, [change(1), change(2), change(3)])
    expect(await repo.nextSeq(PROJECT)).toBe(4)

    await repo.appendChanges(PROJECT, [change(4), change(5)])
    expect(await repo.nextSeq(PROJECT)).toBe(6)

    // seq tính riêng mỗi project
    expect(await repo.nextSeq(OTHER_PROJECT)).toBe(1)
  })

  it("seq trong lô không liên tục ⇒ 422, không ghi gì", async () => {
    await expect(repo.appendChanges(PROJECT, [change(1), change(3)])).rejects.toMatchObject({
      statusCode: 422,
      code: repo.CHANGE_INVALID
    })
    expect(await repo.nextSeq(PROJECT)).toBe(1)
  })

  it("seq đã tồn tại ⇒ 409 CHANGE_SEQ_CONFLICT", async () => {
    await repo.appendChanges(PROJECT, [change(1)])
    await expect(repo.appendChanges(PROJECT, [change(1)])).rejects.toMatchObject({
      statusCode: 409,
      code: repo.CHANGE_SEQ_CONFLICT
    })
  })

  it("listChanges trả theo seq tăng dần, khoảng bao gồm hai đầu", async () => {
    await repo.appendChanges(PROJECT, [change(1), change(2), change(3), change(4)])
    await repo.appendChanges(OTHER_PROJECT, [change(1)])

    const all = await repo.listChanges(PROJECT)
    expect(all.map((c) => c.seq)).toEqual([1, 2, 3, 4])
    expect(all[0]).toEqual({ projectId: PROJECT, ...change(1) })

    const range = await repo.listChanges(PROJECT, { fromSeq: 2, toSeq: 3 })
    expect(range.map((c) => c.seq)).toEqual([2, 3])
  })
})
