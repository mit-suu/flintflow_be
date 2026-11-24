/**
 * FLF-474 (plan fix #7 phần 7c), integration: `applyTransaction` cấp mã mới phải né mã đã từng bị xoá của dự án
 * (lấy từ lịch sử `changes` qua `spine/change-log.ts` `retiredIds`), và hoàn tác lô xoá vẫn trả đúng mã cũ (tập
 * `retired` chỉ chặn CẤP MÃ MỚI, không chặn op `add` có id tường minh của đường revert).
 *
 * Mock DB trong bộ nhớ — cùng ngữ nghĩa `undo.test.ts` (T08), không cần Mongo thật.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect, vi, beforeEach } from "vitest"

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
        const e = expected as { $gte?: number; $lte?: number; $gt?: number; $in?: unknown[] }
        if (e.$in) return e.$in.map(String).includes(String(actual))
        const n = Number(actual)
        return (e.$gte === undefined || n >= e.$gte) && (e.$lte === undefined || n <= e.$lte) && (e.$gt === undefined || n > e.$gt)
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
      const created = { _id: crypto.randomUUID(), ...filter, ...copy(update.$setOnInsert ?? {}) }
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
import { applyTransaction, revertRange } from "./op-engine.js"
import { clearChangeLogs } from "./change-log.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE: Spine = spineSchema.parse(
  JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/spine-fixture-19-screens.json"), "utf8"))
)

const PROJECT = "650000000000000000000001"
const USER = "650000000000000000000010"

const seed = async (): Promise<void> => {
  await repo.getOrCreate(PROJECT)
  db.spines[0] = { _id: crypto.randomUUID(), projectId: PROJECT, ...structuredClone(FIXTURE) }
}

beforeEach(async () => {
  db.reset()
  clearChangeLogs()
  await seed()
})

describe("FLF-474: cấp lại mã của phần tử đã xoá (plan fix #7 phần 7c)", () => {
  it("xoá phần tử mang mã lớn nhất rồi thêm phần tử mới không id ⇒ mã kế tiếp, không cấp lại mã đã xoá", async () => {
    expect(FIXTURE.glossary.map((g) => g.id)).toContain("G16")
    const removed = await applyTransaction(PROJECT, { base_version: FIXTURE.spine_version, by: USER, ops: [{ op: "remove", path: "glossary[id=G16]" }] })
    expect(removed.spine.glossary.some((g) => g.id === "G16")).toBe(false)

    const added = await applyTransaction(PROJECT, {
      base_version: removed.spine_version,
      by: USER,
      ops: [{ op: "add", path: "glossary[]", value: { term: "Retired Id", definition: "FLF-474" } }]
    })
    const newTerm = added.spine.glossary.find((g) => g.term === "Retired Id")!
    expect(newTerm.id).toBe("G17") // không phải "G16" — mã đó đã bị xoá
  })

  it("hoàn tác lô xoá vẫn trả đúng mã cũ (tập retired không chặn op add có id tường minh của revert)", async () => {
    const removed = await applyTransaction(PROJECT, { base_version: FIXTURE.spine_version, by: USER, ops: [{ op: "remove", path: "glossary[id=G16]" }] })
    const removalChanges = removed.changes
    const firstSeq = Math.min(...removalChanges.map((c) => c.seq))
    const lastSeq = Math.max(...removalChanges.map((c) => c.seq))

    // Một lô khác đã dùng mã kế tiếp (không liên quan tới việc revert) — vẫn giữ nguyên, không bị đụng
    const added = await applyTransaction(PROJECT, {
      base_version: removed.spine_version,
      by: USER,
      ops: [{ op: "add", path: "glossary[]", value: { term: "Another Term", definition: "x" } }]
    })
    expect(added.spine.glossary.find((g) => g.term === "Another Term")!.id).toBe("G17")

    const reverted = await revertRange(PROJECT, firstSeq, lastSeq, { by: USER, base_version: added.spine_version })
    const restored = reverted.spine.glossary.find((g) => g.id === "G16")
    expect(restored).toMatchObject(FIXTURE.glossary.find((g) => g.id === "G16")!)
    // Mã cấp sau cùng (G17) không bị revert đụng tới
    expect(reverted.spine.glossary.some((g) => g.id === "G17")).toBe(true)
  })
})
