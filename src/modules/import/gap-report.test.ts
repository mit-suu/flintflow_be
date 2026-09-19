/**
 * Gap report (nút 1.13, UC-23) — phần hàm thuần: xuất .docx mở được (đọc lại bằng `docx-ooxml`), tiêu đề section.
 * Plan §8.2 `gap-report.test.ts`. FLF-172 P4. Gộp nhóm từ Spine/profile/draft thật ở
 * `test/integration/mode1/gap-report.int.test.ts`.
 */
import { describe, expect, it } from "vitest"
import { DocxPackage, readBlocks } from "../docx-ooxml/index.js"
import type { Flag } from "../spine/spine.types.js"
import { gapReportSchema, type GapReport } from "./import.dto.js"
import { renderGapReportDocx, titleOfSection } from "./gap-report.service.js"

const flag = (id: string, level: "red" | "yellow", rule_id: string, section_id: string, message: string): Flag => ({
  id,
  level,
  rule_id,
  section_id,
  target_id: null,
  message,
  remediation_step: "C-1",
  opened_at_version: 1,
  resolved_at: null,
  waived_by_user: false,
  waive_reason: null,
  waived_at_version: null
})

const REPORT: GapReport = gapReportSchema.parse({
  project_id: "66f000000000000000000001",
  doc_version: "0.0",
  generated_at: "2026-09-19T00:00:00.000Z",
  totals: { red: 1, yellow: 2, missing_sections: 1, unmapped_headings: 1, low_confidence_fields: 1 },
  sections: [
    { section_id: "fixed:4.2.3", title: "Performance", flags: [flag("FL001", "red", "dead_reference", "fixed:4.2.3", "NFR trỏ UC-99"), flag("FL002", "yellow", "import_semantic", "fixed:4.2.3", "[ambiguity] 95% cần tải")] },
    { section_id: "feature:F-3.2", title: "Authentication", flags: [flag("FL003", "yellow", "empty_feature", "feature:F-3.2", "Feature rỗng")] }
  ],
  missing_sections: [{ section_id: "fixed:3.1.1", title: "Screen Flow" }],
  unmapped_headings: [{ block_id: "B0045", text: "5.9 Team Notes" }],
  low_confidence_fields: [
    { section_id: "function:@B0031", path: "functions[id=FR-3.2.1].trigger", value: "Learner submits", confidence: 0.5, source_block_ids: ["B0032"], origin: "ai", confirmed: false }
  ]
})

const texts = async (buf: Buffer) => (await readBlocks(await DocxPackage.load(buf))).map((b) => ({ kind: b.kind, text: b.text }))

describe("renderGapReportDocx — xuất .docx mở được", () => {
  it("đọc lại bằng docx-ooxml: tiêu đề, bảng tổng quan, cờ theo section (đỏ trước), mục thiếu, heading lạ, field độ tin thấp", async () => {
    const buf = await renderGapReportDocx(REPORT, "Lumen")
    expect(buf.subarray(0, 4).toString("hex")).toBe("504b0304")
    const blocks = await texts(buf)
    const all = blocks.map((b) => b.text)
    expect(all[0]).toBe("Gap report — Lumen")
    for (const h of ["Tổng quan", "Cờ theo section", "Section bắt buộc thiếu", "Heading không khớp template", "Field độ tin thấp"]) expect(all).toContain(h)
    expect(all).toContain("Performance (fixed:4.2.3)")
    expect(all).toContain("Authentication (feature:F-3.2)")
    const tables = blocks.filter((b) => b.kind === "table").map((b) => b.text)
    expect(tables[0]).toContain("Cờ đỏ | 1")
    expect(tables[0]).toContain("Cờ vàng | 2")
    expect(tables[1].split("\n")).toEqual(["Mức | Luật | Nội dung", "Đỏ | dead_reference | NFR trỏ UC-99", "Vàng | import_semantic | [ambiguity] 95% cần tải"])
    expect(tables.some((t) => t.includes("fixed:3.1.1 | Screen Flow"))).toBe(true)
    expect(tables.some((t) => t.includes("B0045 | 5.9 Team Notes"))).toBe(true)
    expect(tables.some((t) => t.includes("functions[id=FR-3.2.1].trigger | Learner submits | 0.50"))).toBe(true)
  })

  it("báo cáo rỗng ⇒ câu 'không có' thay cho bảng, file vẫn hợp lệ", async () => {
    const empty = gapReportSchema.parse({
      ...REPORT,
      totals: { red: 0, yellow: 0, missing_sections: 0, unmapped_headings: 0, low_confidence_fields: 0 },
      sections: [],
      missing_sections: [],
      unmapped_headings: [],
      low_confidence_fields: []
    })
    const all = (await texts(await renderGapReportDocx(empty, "Rỗng"))).map((b) => b.text)
    expect(all).toEqual(expect.arrayContaining(["Không có cờ nào đang mở.", "Không thiếu section bắt buộc nào.", "Mọi heading đều khớp.", "Không có."]))
  })

  it("giá trị đã sửa (edited_value) thắng value; giá trị không phải chuỗi được JSON hoá", async () => {
    const r = gapReportSchema.parse({
      ...REPORT,
      low_confidence_fields: [
        { ...REPORT.low_confidence_fields[0], edited_value: "Learner clicks Log in" },
        { ...REPORT.low_confidence_fields[0], path: "functions[id=FR-3.2.1].normal", value: ["a", "b"] }
      ]
    })
    const tables = (await texts(await renderGapReportDocx(r, "Lumen"))).filter((b) => b.kind === "table").map((b) => b.text)
    const last = tables[tables.length - 1]
    expect(last).toContain("Learner clicks Log in")
    expect(last).not.toContain("Learner submits")
    expect(last).toContain('["a","b"]')
  })
})

describe("titleOfSection", () => {
  const spine = { features: [{ id: "F-3.2", name: "Authentication" }], functions: [{ id: "FR-3.2.1", name: "Register account" }] } as never
  it("section cố định theo registry, feature/function theo tên trong Spine, không tìm thấy ⇒ giữ id", () => {
    expect(titleOfSection(spine, "fixed:3.1.1")).toBe("Screens Flow")
    expect(titleOfSection(spine, "feature:F-3.2")).toBe("Authentication")
    expect(titleOfSection(spine, "function:FR-3.2.1")).toBe("Register account")
    expect(titleOfSection(spine, "function:FR-9")).toBe("function:FR-9")
    expect(titleOfSection(spine, "fixed:9.9")).toBe("fixed:9.9")
  })
})
