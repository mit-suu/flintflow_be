import { describe, expect, it } from "vitest"
import type { Op } from "../spine/op.types.js"
import type { Spine } from "../spine/spine.types.js"
import { briefQuoteSources, dropUngroundedGaps } from "./gap-quote.js"

const spine = {
  addendum: [{ id: "AD1", topic: "scope", content: "Khách thanh toán online.", content_en: "Customers pay online.", target_section: "fixed:1", captured_at: "2026-11-23T00:00:00.000Z" }],
  project: { name: "Đặt bàn", system_name: "Table Booking", vision: "Diners book a table in under a minute.", goals: ["Halve phone bookings"], release_scope: { in: ["Online deposit"], out: [] } }
} as unknown as Pick<Spine, "addendum" | "project">

const gap = (id: string, source_quote?: unknown): Op => ({
  op: "add",
  path: "other_requirements[]",
  value: { id, kind: "open_question", statement: `Gap ${id}?`, ...(source_quote !== undefined ? { source_quote } : {}) }
})

describe("briefQuoteSources", () => {
  it("gồm lời gốc + bản tiếng Anh của addendum, mọi chữ của project, nguồn thêm; bỏ rỗng", () => {
    const sources = briefQuoteSources(spine, ["[D1-P01] Doc text", null, undefined, ""])
    expect(sources).toEqual(expect.arrayContaining(["Khách thanh toán online.", "Customers pay online.", "Table Booking", "Halve phone bookings", "Online deposit", "[D1-P01] Doc text"]))
    expect(sources).not.toContain("")
  })
})

describe("dropUngroundedGaps - FLF-449 việc 16", () => {
  const sources = briefQuoteSources(spine, ["[D1-P01] Refunds need the manager."])

  it("S-1.4: giữ chỗ thiếu trích đúng, bỏ chỗ thiếu trích bịa / không trích / trích không phải chuỗi", () => {
    const ops = [gap("OR1", "thanh toán online"), gap("OR2", "Refunds need the manager"), gap("OR3", "pay by card"), gap("OR4"), gap("OR5", 42)]
    const { ops: kept, dropped } = dropUngroundedGaps(ops, "S-1.4", sources)
    expect(kept.map((o) => (o.value as { id: string }).id)).toEqual(["OR1", "OR2"])
    expect(dropped).toEqual([
      { id: "OR3", statement: "Gap OR3?", source_quote: "pay by card" },
      { id: "OR4", statement: "Gap OR4?", source_quote: null },
      { id: "OR5", statement: "Gap OR5?", source_quote: null }
    ])
  })

  it("không đụng op khác: giả định, mục kind khác, op set / remove", () => {
    const ops: Op[] = [
      { op: "add", path: "assumptions[]", value: { id: "AS1", statement: "x" } },
      { op: "add", path: "other_requirements[]", value: { id: "OR9", kind: "risk", statement: "Risk" } },
      { op: "set", path: "other_requirements[id=OR1].statement", value: "New" },
      { op: "remove", path: "other_requirements[id=OR2]" }
    ]
    expect(dropUngroundedGaps(ops, "S-1.4", sources)).toEqual({ ops, dropped: [] })
  })

  it("bước khác S-1.4 ⇒ lô nguyên vẹn", () => {
    const ops = [gap("OR1"), gap("OR2", "bịa")]
    for (const step of ["S-1.3", "S-1.1", "B-1.6"]) expect(dropUngroundedGaps(ops, step, sources)).toEqual({ ops, dropped: [] })
  })
})
