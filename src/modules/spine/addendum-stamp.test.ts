import { describe, it, expect } from "vitest"
import { stampAddendum } from "./addendum-stamp.js"

describe("stampAddendum", () => {
  const now = new Date("2026-09-30T01:40:00.000Z")

  it("add addendum[] ⇒ captured_at là giờ server, ghi đè ngày model bịa", () => {
    const ops = [{ op: "add", path: "addendum[]", value: { id: "AD1", topic: "t", captured_at: "2024-01-01T00:00:00.000Z" } }]
    expect(stampAddendum(ops, now)).toEqual([{ op: "add", path: "addendum[]", value: { id: "AD1", topic: "t", captured_at: "2026-09-30T01:40:00.000Z" } }])
  })

  it("model bỏ trống captured_at ⇒ vẫn được đóng dấu", () => {
    const [op] = stampAddendum([{ op: "add", path: "addendum[]", value: { id: "AD2" } as Record<string, unknown> }], now)
    expect(op.value.captured_at).toBe("2026-09-30T01:40:00.000Z")
  })

  it("op khác giữ nguyên, không đổi thứ tự", () => {
    const ops = [
      { op: "set", path: "project.vision", value: "x" },
      { op: "set", path: "addendum[id=AD1].captured_at", value: "2024-01-01T00:00:00.000Z" },
      { op: "add", path: "actors[]", value: { name: "A", captured_at: "keep" } }
    ]
    expect(stampAddendum(ops, now)).toEqual(ops)
  })
})
