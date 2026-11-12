import { describe, expect, it } from "vitest"
import { buildProjectIndex } from "./chunk-index.service.js"
import { evaluateRetrieval } from "./eval-metrics.js"

const base = { heading_path: [], titles: [], p_start: 0, p_end: 0, tokens: 50 }
const index = buildProjectIndex([
  {
    ref: { id: "d", docCode: 1, name: "srs.txt" },
    chunks: [
      { ...base, ordinal: 0, paragraphs: ["UC-05 Đăng ký học phần: sinh viên đăng ký lớp đang mở."] },
      { ...base, ordinal: 1, paragraphs: ["Tổng tín chỉ mỗi kỳ không vượt quá 20."] },
      { ...base, ordinal: 2, paragraphs: ["Cổng thanh toán xác nhận giao dịch."] }
    ]
  }
])

describe("evaluateRetrieval (FLF-393)", () => {
  it("trúng khi chunk được chọn chứa chuỗi mong đợi (không phân biệt dấu); recall theo nhóm", () => {
    const report = evaluateRetrieval(
      index,
      [
        { q: "UC-05", expect: ["dang ky hoc phan"], kind: "code" },
        { q: "tin chi toi da", expect: ["không vượt quá 20"], kind: "vi_no_accent" },
        { q: "blockchain", expect: ["Cổng thanh toán"], kind: "miss" }
      ],
      { topK: 1, maxTokens: 1000 }
    )
    expect(report.results.map((r) => r.hit)).toEqual([true, true, false])
    expect(report.results[0]!.rank).toBe(1)
    expect(report.results[2]!.rank).toBeNull()
    expect(report.recall).toBeCloseTo(2 / 3)
    expect(report.recallByKind).toEqual({ code: { hit: 1, total: 1 }, vi_no_accent: { hit: 1, total: 1 }, miss: { hit: 0, total: 1 } })
    expect(report.maxTokens).toBeLessThanOrEqual(1000)
  })
})
