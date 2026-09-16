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
      return String(actual) === String(expected)
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
    findOneAndUpdate: async (filter: Record<string, unknown>, update: { $set: Doc }) => {
      const row = rows.find((r) => matches(r, filter))
      if (!row) return null
      const before = copy(row)
      Object.assign(row, copy(update.$set))
      return before
    },
    countDocuments: async (filter: Record<string, unknown>) => rows.filter((r) => matches(r, filter)).length,
    /** Simule tối thiểu cho `roundCountsForSteps` (F10): $match rồi $project step_id/call_kind/createdAt. */
    aggregate: async (pipeline: Record<string, unknown>[]) => {
      const match = (pipeline[0] as { $match: Record<string, unknown> }).$match
      return rows
        .filter((r) => matches(r, { projectId: String(match.projectId), step_id: match.step_id, state: match.state }))
        .map((r) => ({ step_id: r.step_id, call_kind: r.call_kind, createdAt: r.createdAt }))
    }
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
vi.mock("../../shared/ai/credit-reservation.service.js", () => ({ refundDeductedCredit: vi.fn(async () => undefined) }))

import { listChanges } from "../spine/spine.repository.js"
import { refundDeductedCredit } from "../../shared/ai/credit-reservation.service.js"
import { countCalls, recordUsage, refundUsage, roundStartedAt, roundCounts, roundCountsForSteps, reserveCall, finalizeCall, releaseCall } from "./meter.service.js"

const PROJECT = "650000000000000000000001"
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

  it("refundUsage hoàn cost của dòng deducted về ví đúng một lần (gọi lại không hoàn thêm)", async () => {
    vi.mocked(refundDeductedCredit).mockClear()
    const ids = await recordUsage(PROJECT, USER, STEP, [entry("draft")])
    const reservedId = await reserveCall(PROJECT, USER, STEP, "draft")
    await refundUsage([...ids, reservedId])
    await refundUsage(ids)
    expect(refundDeductedCredit).toHaveBeenCalledTimes(1)
    expect(refundDeductedCredit).toHaveBeenCalledWith({ userId: USER, actionType: "draft", amount: 4, projectId: PROJECT })
    expect(db.rows.every((r) => r.state === "refunded")).toBe(true)
  })

  it("countCalls không đếm step khác hay project khác", async () => {
    await recordUsage(PROJECT, USER, STEP, [entry("draft")])
    await recordUsage(PROJECT, USER, "S-3.2", [entry("draft")])
    await recordUsage("other-project", USER, STEP, [entry("draft")])
    expect(await countCalls(PROJECT, STEP)).toBe(1)
  })

  it("reserveCall ghi state=reserved (tính vào countCalls ngay dù model chưa trả lời — F2/F11)", async () => {
    const usageId = await reserveCall(PROJECT, USER, STEP, "draft")
    expect(db.rows).toHaveLength(1)
    expect(db.rows[0]).toMatchObject({ state: "reserved", tokens_in: 0, tokens_out: 0, cost: 0 })
    expect(await countCalls(PROJECT, STEP)).toBe(1)
    void usageId
  })

  it("finalizeCall điền số liệu thật + chuyển deducted", async () => {
    const usageId = await reserveCall(PROJECT, USER, STEP, "draft")
    await finalizeCall(usageId, entry("draft"))
    expect(db.rows[0]).toMatchObject({ state: "deducted", tokens_in: 100, tokens_out: 50, cost: 4, logId: "log-1" })
  })

  it("releaseCall chuyển refunded — không tiêu trần", async () => {
    const usageId = await reserveCall(PROJECT, USER, STEP, "draft")
    await releaseCall(usageId)
    expect(db.rows[0].state).toBe("refunded")
    expect(await countCalls(PROJECT, STEP)).toBe(0)
  })

  it("roundStartedAt trả null khi chưa từng có change đặt step in_progress (vòng đầu tiên, firstSeq=null ⇒ không giới hạn)", async () => {
    vi.mocked(listChanges).mockResolvedValue([])
    expect(await roundStartedAt(PROJECT, STEP, null)).toBeNull()
    expect(listChanges).toHaveBeenCalledWith(PROJECT, {})
  })

  it("roundStartedAt đọc `at` của change GẦN NHẤT đặt steps[id=X].status=in_progress TRƯỚC firstSeq — không phải first_seq (F1)", async () => {
    vi.mocked(listChanges).mockResolvedValue([{ path: `steps[id=${STEP}].status`, value: "in_progress", at: "2026-09-14T09:00:00.000Z", seq: 5 }] as never)
    const at = await roundStartedAt(PROJECT, STEP, 10)
    expect(at).toEqual(new Date("2026-09-14T09:00:00.000Z"))
    // Chặn theo firstSeq - 1: chỉ tìm change TRƯỚC nội dung đầu tiên của vòng hiện tại.
    expect(listChanges).toHaveBeenCalledWith(PROJECT, { toSeq: 9 })
  })

  it("roundStartedAt KHÔNG nhận transition SAU firstSeq làm mốc — tránh nhầm toggle revision_requested→in_progress nội bộ của gate (F1)", async () => {
    // gate.service đặt lại status=in_progress SAU khi revision hoàn tất (seq=20, sau firstSeq=10) — không
    // phải mốc vòng mới, chỉ là toggle hiển thị; roundStartedAt phải bỏ qua transition này.
    vi.mocked(listChanges).mockResolvedValue([
      { path: `steps[id=${STEP}].status`, value: "in_progress", at: "2025-06-01T00:00:00.000Z", seq: 3 },
      { path: `steps[id=${STEP}].status`, value: "in_progress", at: "2025-06-02T00:00:00.000Z", seq: 20 }
    ] as never)
    const at = await roundStartedAt(PROJECT, STEP, 10)
    expect(at).toEqual(new Date("2025-06-01T00:00:00.000Z"))
  })

  it("countCalls với since chỉ đếm usage tạo sau mốc vòng hiện tại", async () => {
    const ids = await recordUsage(PROJECT, USER, STEP, [entry("draft")])
    // Giả lập usage của vòng trước: tạo trước mốc since
    db.rows.find((r) => r._id === ids[0])!.createdAt = "2020-01-01T00:00:00.000Z"
    await recordUsage(PROJECT, USER, STEP, [entry("draft")])
    expect(await countCalls(PROJECT, STEP, { since: new Date("2025-01-01T00:00:00.000Z") })).toBe(1)
  })

  it("roundCounts gộp calls_used + regenerate_used theo mốc vòng do roundStartedAt trả về", async () => {
    vi.mocked(listChanges).mockResolvedValue([])
    await recordUsage(PROJECT, USER, STEP, [entry("draft"), entry("regenerate")])
    const counts = await roundCounts(PROJECT, STEP, null)
    expect(counts).toEqual({ calls_used: 2, regenerate_used: 1 })
  })

  describe("roundCountsForSteps (F10 — GET /steps không N+1)", () => {
    it("trả 0/0 cho danh sách step rỗng, không gọi DB", async () => {
      const result = await roundCountsForSteps(PROJECT, [])
      expect(result.size).toBe(0)
      expect(listChanges).not.toHaveBeenCalled()
    })

    it("đếm đúng nhiều step trong MỘT lần gọi, tôn trọng mốc vòng riêng từng step — kể cả usage ghi GIỮA mốc thật và toggle nội bộ sau firstSeq", async () => {
      await recordUsage(PROJECT, USER, "S-3.2", [entry("draft")])
      // usage của S-3.1 nhưng thuộc vòng TRƯỚC (trước mốc in_progress hiện tại) — không được đếm
      const stale = await recordUsage(PROJECT, USER, "S-3.1", [entry("draft")])
      db.rows.find((r) => r._id === stale[0])!.createdAt = "2020-01-01T00:00:00.000Z"
      // usage GIỮA mốc vòng thật (seq=3) và toggle nội bộ sau firstSeq (seq=20) — phải được đếm (F1).
      const currentRound = await recordUsage(PROJECT, USER, "S-3.1", [entry("draft"), entry("regenerate")])
      for (const id of currentRound) db.rows.find((r) => r._id === id)!.createdAt = "2025-06-01T12:00:00.000Z"

      vi.mocked(listChanges).mockResolvedValue([
        { path: "steps[id=S-3.1].status", value: "in_progress", at: "2025-06-01T00:00:00.000Z", seq: 3 },
        { path: "steps[id=S-3.1].status", value: "in_progress", at: "2025-06-02T00:00:00.000Z", seq: 20 }
      ] as never)

      const result = await roundCountsForSteps(PROJECT, [
        { id: "S-3.1", first_seq: 10 },
        { id: "S-3.2", first_seq: null },
        { id: "S-3.3", first_seq: null }
      ])
      expect(result.get("S-3.1")).toEqual({ calls_used: 2, regenerate_used: 1 })
      expect(result.get("S-3.2")).toEqual({ calls_used: 1, regenerate_used: 0 })
      expect(result.get("S-3.3")).toEqual({ calls_used: 0, regenerate_used: 0 })
      // Đúng một lần listChanges cho toàn bộ danh sách step (không N+1)
      expect(listChanges).toHaveBeenCalledTimes(1)
    })
  })
})
