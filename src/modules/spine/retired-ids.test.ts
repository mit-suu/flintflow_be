/**
 * FLF-474 (plan fix #7 phần 7c): `retiredIds` nhóm id đã từng bị xoá của dự án từ lịch sử `changes`, theo đúng khoá
 * collection mà `id-allocator.ts` `allocateId` dùng. Mock nhẹ cùng kiểu với `change-log.test.ts` — chỉ cần
 * `{projectId, seq, op, path}`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => {
  type Row = { _id: string; projectId: string; seq: number; op: string; path: string }
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
  const append = (projectId: string, ...entries: { op: string; path: string }[]) => {
    for (const entry of entries) {
      const seq = Math.max(0, ...rows.filter((r) => r.projectId === projectId).map((r) => r.seq)) + 1
      rows.push({ _id: `c${nextId++}`, projectId, seq, ...entry })
    }
  }
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

import { clearChangeLogs, retiredIds } from "./change-log.js"

const P = "650000000000000000000001"

beforeEach(() => {
  db.reset()
  clearChangeLogs()
})

describe("retiredIds - mã đã từng bị xoá của dự án (FLF-474)", () => {
  it("op remove đúng một phần tử cấp gốc ⇒ nhóm theo collection", async () => {
    db.append(
      P,
      { op: "remove", path: "use_cases[id=UC34]" },
      { op: "set", path: "use_cases[id=UC01].name" },
      { op: "remove", path: "screens[id=S09]" }
    )
    const retired = await retiredIds(P)
    expect(retired.get("use_cases")).toEqual(["UC34"])
    expect(retired.get("screens")).toEqual(["S09"])
  })

  it("op remove lồng (validations của function) ⇒ nhóm theo collection lồng, không theo collection cha", async () => {
    db.append(P, { op: "remove", path: "functions[id=FN001].validations[id=FN001-V1]" })
    const retired = await retiredIds(P)
    expect(retired.get("validations")).toEqual(["FN001-V1"])
    expect(retired.has("functions")).toBe(false)
  })

  it("remove không nhắm phần tử (vd field thường) ⇒ bỏ qua, không nhóm", async () => {
    db.append(P, { op: "remove", path: "custom_sections[id=CS01].blocks" })
    expect((await retiredIds(P)).size).toBe(0)
  })

  it("nhiều mã bị xoá cùng collection ⇒ cộng dồn theo thứ tự", async () => {
    db.append(P, { op: "remove", path: "use_cases[id=UC34]" }, { op: "remove", path: "use_cases[id=UC33]" })
    expect((await retiredIds(P)).get("use_cases")).toEqual(["UC34", "UC33"])
  })

  it("Cần chốt #4: khôi phục bản chụp xoá đuôi changes ⇒ mã không còn tính là đã xoá", async () => {
    db.append(P, { op: "remove", path: "use_cases[id=UC34]" })
    expect((await retiredIds(P)).get("use_cases")).toEqual(["UC34"])
    // restoreSnapshot: xoá đuôi changes từ seq 1 (change xoá UC34 không còn)
    db.dropFrom(P, 1)
    expect((await retiredIds(P)).has("use_cases")).toBe(false)
  })
})
