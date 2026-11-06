import { beforeEach, describe, expect, it, vi } from "vitest"

// Kho `changes` trong bộ nhớ — đủ cho `find` (lọc projectId + seq > n, sort seq) và `findOne` (theo seq)
const db = vi.hoisted(() => {
  type Row = { _id: string; projectId: string; seq: number; value: string }
  let rows: Row[] = []
  let nextId = 1
  const matches = (row: Row, filter: Record<string, unknown>): boolean =>
    Object.entries(filter).every(([k, v]) => {
      if (v && typeof v === "object" && "$gt" in v) return Number(row[k as keyof Row]) > (v as { $gt: number }).$gt
      return row[k as keyof Row] === v
    })
  const find = vi.fn(async (filter: Record<string, unknown>) => rows.filter((r) => matches(r, filter)).sort((a, b) => a.seq - b.seq).map((r) => ({ ...r })))
  const findOne = vi.fn(async (filter: Record<string, unknown>) => {
    const row = rows.find((r) => matches(r, filter))
    return row ? { _id: row._id } : null
  })
  const append = (projectId: string, ...values: string[]) => {
    for (const value of values) {
      const seq = Math.max(0, ...rows.filter((r) => r.projectId === projectId).map((r) => r.seq)) + 1
      rows.push({ _id: `c${nextId++}`, projectId, seq, value })
    }
  }
  /** Như `restoreSnapshot`: bỏ đuôi `seq ≥ fromSeq`. */
  const dropFrom = (projectId: string, fromSeq: number) => {
    rows = rows.filter((r) => r.projectId !== projectId || r.seq < fromSeq)
  }
  const reset = () => {
    rows = []
    nextId = 1
    find.mockClear()
    findOne.mockClear()
  }
  return { find, findOne, append, dropFrom, reset }
})

vi.mock("./change.model.js", () => ({ Change: { find: db.find, findOne: db.findOne } }))

import { clearChangeLogs, createChangeLog } from "./change-log.js"

const P = "650000000000000000000001"
const log = createChangeLog<string>(null, (doc: { value: string }) => doc.value)
/** `seq > n` của lượt `find` gần nhất — `null` ⇒ đọc toàn bộ. */
const lastFetchAfter = () => {
  const calls = db.find.mock.calls
  const filter = calls[calls.length - 1]?.[0] as { seq?: { $gt: number } }
  return filter.seq?.$gt ?? null
}

beforeEach(() => {
  db.reset()
  clearChangeLogs()
})

describe("createChangeLog — lịch sử changes đọc tăng dần (FLF-381)", () => {
  it("lượt đầu đọc toàn bộ; lượt sau chỉ tải change mới, kết quả như đọc toàn bộ", async () => {
    db.append(P, "a", "b")
    expect(await log.list(P)).toEqual(["a", "b"])
    expect(lastFetchAfter()).toBeNull()

    db.append(P, "c")
    expect(await log.list(P)).toEqual(["a", "b", "c"])
    expect(lastFetchAfter()).toBe(2)

    // Không có gì mới ⇒ vẫn đủ, chỉ hỏi phần sau mốc
    expect(await log.list(P)).toEqual(["a", "b", "c"])
    expect(lastFetchAfter()).toBe(3)
  })

  it("xoá đuôi rồi ghi lại cùng seq (restoreSnapshot) ⇒ phát hiện qua mốc, đọc lại toàn bộ", async () => {
    db.append(P, "a", "b", "c")
    await log.list(P)
    // seq 2..3 bị bỏ, ghi mới tới seq 4 — seq 2, 3 dùng lại với nội dung khác
    db.dropFrom(P, 2)
    db.append(P, "x", "y", "z")
    expect(await log.list(P)).toEqual(["a", "x", "y", "z"])
    expect(lastFetchAfter()).toBeNull()
  })

  it("xoá đuôi, ghi lại ít hơn mốc cũ ⇒ cũng đọc lại toàn bộ", async () => {
    db.append(P, "a", "b", "c")
    await log.list(P)
    db.dropFrom(P, 2)
    db.append(P, "x")
    expect(await log.list(P)).toEqual(["a", "x"])
  })

  it("bản trả về sửa thoải mái, không làm bẩn lượt sau; project khác không lẫn", async () => {
    db.append(P, "a")
    db.append("650000000000000000000002", "khác")
    const first = await log.list(P)
    first.push("bẩn")
    expect(await log.list(P)).toEqual(["a"])
    expect(await log.list("650000000000000000000002")).toEqual(["khác"])
  })

  it("project chưa có change ⇒ rỗng, lần sau vẫn thấy change mới ghi", async () => {
    expect(await log.list(P)).toEqual([])
    db.append(P, "a")
    expect(await log.list(P)).toEqual(["a"])
  })
})
