import { describe, expect, it } from "vitest"
import { p, styled } from "../docx-ooxml/testing/make-docx.js"
import { makeSrsDocx } from "./testing/srs-fixture.js"
import { skeletonSignature } from "./skeleton-signature.js"
import { buildSkeleton, type PlannedItem } from "./template-skeleton.js"

const OPTS = { projectName: "Lumen", language: "en" as const }
const h = (text: string): PlannedItem<unknown> => ({ kind: "heading", block: null, text, level: 1 })

describe("skeleton-signature (FLF-466 phase 10)", () => {
  it("chữ hướng dẫn, tiêu đề cột và heading đều vào chữ ký; chuẩn hoá hoa thường / số gõ tay", () => {
    const base = [h("1 Introduction"), { kind: "guidance", block: null, text: "Describe the purpose" } as PlannedItem<unknown>]
    const sig = skeletonSignature(base, [])
    expect(skeletonSignature([h("Introduction"), { kind: "guidance", block: null, text: "describe the PURPOSE" }], [])).toBe(sig)
    expect(skeletonSignature([h("1 Introduction"), { kind: "guidance", block: null, text: "Describe the scope" }], [])).not.toBe(sig)
    expect(skeletonSignature([h("1 Introduction"), { kind: "table", block: null, headers: ["A", "B"] }], [])).not.toBe(skeletonSignature([h("1 Introduction")], []))
  })

  it("AI đổi tên riêng (replacements) không đổi dấu khung nhưng đổi chữ trong file; khung có chữ để AI quét", async () => {
    const buffer = await makeSrsDocx({ extraBody: styled("u1", "9 Notes") + p("x") })
    const plain = await buildSkeleton(buffer, OPTS)
    expect(plain.texts.length).toBeGreaterThan(0)
    const target = plain.texts[0]
    const replaced = await buildSkeleton(buffer, OPTS, new Map(), new Map([[target.text, "{Tên khách hàng}"]]))
    expect(replaced.hash).toBe(plain.hash)
    expect(replaced.buffer.equals(plain.buffer)).toBe(false)
  })
})
