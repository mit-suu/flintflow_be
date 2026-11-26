import { describe, it, expect } from "vitest"
import { isSkeletonOnly, skeletonLanguageView, skeletonTranslationTarget, skeletonUnits } from "./skeleton-language.js"
import { skeletonBatches, translateSkeleton } from "./skeleton-translate.js"

const kept = { dropped: false }
const dropped = { dropped: true }

describe("skeletonLanguageView (FLF-456)", () => {
  it("còn một mục giữ nội dung ⇒ không hiện ô, ngôn ngữ theo file dù đã lưu lựa chọn", () => {
    expect(skeletonLanguageView({ language: "en", skeleton_language: "vi" }, [dropped, kept])).toEqual({ visible: false, file: "en", selected: "en" })
    expect(skeletonTranslationTarget({ language: "en", skeleton_language: "vi" }, [dropped, kept])).toBeNull()
  })

  it("mọi mục đã Bỏ chữ ⇒ hiện ô, mặc định theo ngôn ngữ file; ô đổi ngay khi Giữ / Bỏ", () => {
    expect(skeletonLanguageView({ language: "vi" }, [dropped, dropped])).toEqual({ visible: true, file: "vi", selected: "vi" })
    expect(skeletonLanguageView({ language: "vi" }, [dropped, kept]).visible).toBe(false)
  })

  it("file không có mục nào có chữ cũng là chỉ còn khung", () => {
    expect(isSkeletonOnly([])).toBe(true)
  })

  it("chọn khác ngôn ngữ file ⇒ dịch sang ngôn ngữ đó; chọn đúng ngôn ngữ file ⇒ không dịch", () => {
    expect(skeletonTranslationTarget({ language: "en", skeleton_language: "vi" }, [dropped])).toBe("vi")
    expect(skeletonTranslationTarget({ language: "en", skeleton_language: "en" }, [dropped])).toBeNull()
    expect(skeletonTranslationTarget({ language: "en" }, [dropped])).toBeNull()
  })

  it("ngôn ngữ file lạ ⇒ en", () => {
    expect(skeletonLanguageView({ language: "fr" }, [dropped]).file).toBe("en")
  })
})

describe("skeletonUnits (FLF-456)", () => {
  it("gom heading (không kể số mục), tiêu đề cột bảng, chữ hướng dẫn thật; bỏ ô chỗ trống và chỗ không có chữ", () => {
    const units = skeletonUnits([
      { block_id: "B1", kind: "heading", level: 1, text: "3.2 Functional Requirements" },
      { block_id: "B2", kind: "paragraph", text: "[Describe each requirement.]" },
      { block_id: "B3", kind: "paragraph", text: "Chữ thường không phải hướng dẫn" },
      { block_id: "B4", kind: "table", text: "", rows: [["ID", "Requirement", "[Priority]", "2024"], ["", "", "", ""]] },
      { block_id: "B5", kind: "heading", level: 2, text: "1.1" }
    ])
    expect(units.map((u) => u.text)).toEqual(["Functional Requirements", "Describe each requirement.", "ID", "Requirement"])
  })
})

describe("translateSkeleton (FLF-456)", () => {
  const echo = async (input: { promptVariables?: Record<string, string> }) => {
    const items = JSON.parse(input.promptVariables!.items) as { key: string; text: string }[]
    return { data: { items: items.map((i) => ({ key: i.key, text: `[vi] ${i.text}` })) }, cost: 2 } as never
  }

  it("chữ giống nhau dịch một lần; kết quả theo key của từng đơn vị", async () => {
    const units = [
      { key: "u1", text: "Introduction" },
      { key: "u2", text: "Scope" },
      { key: "u3", text: "Introduction" }
    ]
    expect(skeletonBatches(units).flat()).toHaveLength(2)
    const out = await translateSkeleton({ projectId: "p", userId: "u", source: "en", target: "vi", units, executor: echo })
    expect(Object.fromEntries(out)).toEqual({ u1: "[vi] Introduction", u2: "[vi] Scope", u3: "[vi] Introduction" })
  })

  it("model trả lỗi định dạng (422) ⇒ giữ chữ gốc, không ném; lỗi khác (hết credit) ⇒ ném", async () => {
    const units = [{ key: "u1", text: "Introduction" }]
    const parseError = async () => {
      throw Object.assign(new Error("parse"), { statusCode: 422 })
    }
    expect((await translateSkeleton({ projectId: "p", userId: "u", source: "en", target: "vi", units, executor: parseError })).size).toBe(0)
    const noCredit = async () => {
      throw Object.assign(new Error("credit"), { statusCode: 402 })
    }
    await expect(translateSkeleton({ projectId: "p", userId: "u", source: "en", target: "vi", units, executor: noCredit })).rejects.toMatchObject({ statusCode: 402 })
  })

  it("FLF-456: nhiều lô mà số dư không đủ cho mọi lô ⇒ 402 trước khi chạy lô đầu (không trừ credit lô 1 rồi mất)", async () => {
    const units = Array.from({ length: 200 }, (_, n) => ({ key: `u${n}`, text: `Heading number ${n} `.repeat(30) }))
    expect(skeletonBatches(units).length).toBeGreaterThan(1)
    let calls = 0
    const counting = async (input: { promptVariables?: Record<string, string> }) => {
      calls++
      return echo(input)
    }
    await expect(
      translateSkeleton({ projectId: "p", userId: "u", source: "en", target: "vi", units, executor: counting, availableCredits: async () => 1 })
    ).rejects.toMatchObject({ code: "INSUFFICIENT_CREDIT" })
    expect(calls).toBe(0)
    await translateSkeleton({ projectId: "p", userId: "u", source: "en", target: "vi", units, executor: counting, availableCredits: async () => 100000 })
    expect(calls).toBeGreaterThan(1)
  })
})
