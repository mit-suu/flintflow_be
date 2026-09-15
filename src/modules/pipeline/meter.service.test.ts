import { describe, it, expect, vi, beforeEach } from "vitest"

/** Store trong bộ nhớ thay model Mongoose Usage — cùng ngữ nghĩa flags.service.test.ts. */
const db = vi.hoisted(() => {
  type Doc = Record<string, unknown>
  const rows: Doc[] = []
  let seq = 0
  const copy = <X>(x: X): X => structuredClone(x)
  const matches = (doc: Doc, filter: Record<string, unknown>): boolean =>
    Object.entries(filter).every(([key, expected]) => {
      const actual = doc[key]
      if (typeof expected === "object" && expected !== null) {
        const e = expected as { $ne?: unknown; $in?: unknown[]; $gte?: string | Date }
        if ("$ne" in e) return actual !== e.$ne
        if (e.$in) return e.$in.map(String).includes(String(actual))
        if (e.$gte !== undefined) return new Date(actual as string) >= new Date(e.$gte)
      }
      return actual === expected
    })
  const Usage = {
    insertMany: async (docs: Doc[]) => {
      const created = docs.map((d) => ({ _id: `u${++seq}`, createdAt: new Date().toISOString(), ...copy(d) }))
      rows.push(...created)
      return created.map(copy)
    },
    updateMany: async (filter: Record<string, unknown>, update: { $set: Doc }) => {
      const matched = rows.filter((r) => matches(r, filter))
      for (const r of matched) Object.assign(r, copy(update.$set))
      return { modifiedCount: matched.length }
    },
    countDocuments: async (filter: Record<string, unknown>) => rows.filter((r) => matches(r, filter)).length
  }
  const reset = () => {
    rows.length = 0
    seq = 0
  }
  return { Usage, rows, reset }
})

vi.mock("../spine/usage.model.js", () => ({ Usage: db.Usage }))
vi.mock("../spine/spine.repository.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../spine/spine.repository.js")>()
  return { ...actual, listChanges: vi.fn() }
})

import { listChanges } from "../spine/spine.repository.js"
import { countCalls, recordUsage, refundUsage, roundStartedAt } from "./meter.service.js"

const PROJECT = "p1"
const USER = "u1"
const STEP = "S-3.1"

const entry = (call_kind: string, attempt = 1) => ({ call_kind, attempt, tokens_in: 100, tokens_out: 50, cost: 4, logId: "log-1" })

beforeEach(() => {
  db.reset()
  vi.mocked(listChanges).mockReset()
})

describe("meter.service", () => {
  it("recordUsage ghi state=deducted, countCalls đếm đúng theo step + call_kind", async () => {
    const ids = await recordUsage(PROJECT, USER, STEP, [entry("draft"), entry("regenerate")])
    expect(ids).toHaveLength(2)
    expect(await countCalls(PROJECT, STEP)).toBe(2)
    expect(await countCalls(PROJECT, STEP, { callKind: "regenerate" })).toBe(1)
    expect(db.rows.every((r) => r.state === "deducted")).toBe(true)
  })

  it("refundUsage đánh dấu refunded — loại khỏi countCalls (không tiêu trần)", async () => {
    const ids = await recordUsage(PROJECT, USER, STEP, [entry("draft")])
    expect(await countCalls(PROJECT, STEP)).toBe(1)
    await refundUsage(ids)
    expect(await countCalls(PROJECT, STEP)).toBe(0)
    expect(db.rows[0].state).toBe("refunded")
  })

  it("countCalls không đếm step khác hay project khác", async () => {
    await recordUsage(PROJECT, USER, STEP, [entry("draft")])
    await recordUsage(PROJECT, USER, "S-3.2", [entry("draft")])
    await recordUsage("other-project", USER, STEP, [entry("draft")])
    expect(await countCalls(PROJECT, STEP)).toBe(1)
  })

  it("roundStartedAt trả null khi step chưa có first_seq (vòng đầu tiên)", async () => {
    expect(await roundStartedAt(PROJECT, undefined)).toBeNull()
    expect(await roundStartedAt(PROJECT, { first_seq: null })).toBeNull()
    expect(listChanges).not.toHaveBeenCalled()
  })

  it("roundStartedAt đọc `at` của change tại first_seq — dùng làm mốc đếm vòng hiện tại", async () => {
    vi.mocked(listChanges).mockResolvedValue([{ at: "2026-09-14T10:00:00.000Z" } as never])
    const at = await roundStartedAt(PROJECT, { first_seq: 42 })
    expect(at).toEqual(new Date("2026-09-14T10:00:00.000Z"))
    expect(listChanges).toHaveBeenCalledWith(PROJECT, { fromSeq: 42, toSeq: 42 })
  })

  it("countCalls với since chỉ đếm usage tạo sau mốc vòng hiện tại", async () => {
    const ids = await recordUsage(PROJECT, USER, STEP, [entry("draft")])
    // Giả lập usage của vòng trước: tạo trước mốc since
    db.rows.find((r) => r._id === ids[0])!.createdAt = "2020-01-01T00:00:00.000Z"
    await recordUsage(PROJECT, USER, STEP, [entry("draft")])
    expect(await countCalls(PROJECT, STEP, { since: new Date("2025-01-01T00:00:00.000Z") })).toBe(1)
  })
})
