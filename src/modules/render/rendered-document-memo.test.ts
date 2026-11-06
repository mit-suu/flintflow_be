import { beforeEach, describe, expect, it } from "vitest"
import { cacheMemoKey, clearDocumentMemo, createMemo } from "./rendered-document-memo.js"

describe("rendered-document-memo (FLF-381)", () => {
  beforeEach(() => clearDocumentMemo())

  it("cacheMemoKey đổi khi document cache được ghi lại (updatedAt), giữ nguyên khi không", () => {
    const at = new Date("2026-11-06T00:00:00.000Z")
    expect(cacheMemoKey({ _id: "c1", updatedAt: at })).toBe(cacheMemoKey({ _id: "c1", updatedAt: new Date(at) }))
    expect(cacheMemoKey({ _id: "c1", updatedAt: new Date(at.getTime() + 1) })).not.toBe(cacheMemoKey({ _id: "c1", updatedAt: at }))
    expect(cacheMemoKey({ _id: "c2", updatedAt: at })).not.toBe(cacheMemoKey({ _id: "c1", updatedAt: at }))
  })

  it("vào / ra đều là bản sao: sửa bản nhận về hay bản đã đưa vào không làm bẩn bộ nhớ", () => {
    const memo = createMemo<{ heading: string }>()
    const value = { heading: "gốc" }
    memo.set("k", value)
    value.heading = "sửa sau khi đưa vào"
    const got = memo.get("k")!
    got.heading = "sửa bản nhận về"
    expect(memo.get("k")).toEqual({ heading: "gốc" })
    expect(memo.get("khác")).toBeNull()
  })

  it("LRU có trần: quá trần thì bỏ mục ít dùng nhất; dùng lại thì giữ", () => {
    const memo = createMemo<number>(2)
    memo.set("a", 1)
    memo.set("b", 2)
    memo.get("a")
    memo.set("c", 3)
    expect(memo.get("a")).toBe(1)
    expect(memo.get("b")).toBeNull()
    expect(memo.get("c")).toBe(3)
  })

  it("clearDocumentMemo dọn mọi bộ đã tạo", () => {
    const first = createMemo<number>()
    const second = createMemo<number>()
    first.set("x", 1)
    second.set("y", 2)
    clearDocumentMemo()
    expect(first.get("x")).toBeNull()
    expect(second.get("y")).toBeNull()
  })
})
