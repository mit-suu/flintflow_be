/** FLF-343: độ chính xác khớp mẫu I-3 trên các biến thể sinh từ cùng một dàn mục — chặn ở ≥ 90 % (CI) + biến thể âm tính. */
import { describe, expect, it } from "vitest"
import { HARNESS_VARIANTS, NEGATIVE_VARIANTS, buildNegative, buildVariant, checkNegative, matchReport, runHarness } from "./match-harness.js"

describe("match harness (FLF-343)", () => {
  it("mọi biến thể (style, in đậm, numPr, đổi tên, style riêng, mục lục Word / gõ tay) ≥ 90 % heading vào đúng mục", async () => {
    const { variants, accuracy } = await runHarness()
    expect(variants.map((v) => v.variant)).toEqual([...HARNESS_VARIANTS])
    for (const v of variants) {
      expect(v.accuracy, `${v.variant}: ${JSON.stringify(v.misses)}`).toBeGreaterThanOrEqual(0.9)
      // mục lục không bao giờ thành nội dung
      expect(v.toc_blocks, v.variant).toBe(0)
    }
    expect(accuracy).toBeGreaterThanOrEqual(0.9)
  })

  it.each(NEGATIVE_VARIANTS)("âm tính %s: không thêm heading, không mất đoạn nào", async (variant) => {
    const c = await buildNegative(variant)
    expect(await checkNegative(c.buffer, c.headings, c.keep)).toEqual({ extra_headings: [], dropped: [] })
  })

  it("matchReport: bản đồ heading, phân bố độ tin, số chỗ Cần xem", async () => {
    const report = await matchReport(await buildVariant("bold"))
    expect(report.headings.length).toBeGreaterThan(20)
    expect(Object.values(report.histogram).reduce((a, b) => a + b, 0)).toBe(report.headings.length)
    expect(report.needs_review.headings).toBe(report.headings.filter((h) => h.confidence < 0.8).length)
  })
})
