/**
 * Gap report (nút 1.13, UC-23) — phần hàm thuần: xuất .docx mở được (đọc lại bằng `docx-ooxml`), tiêu đề section.
 * Plan §8.2 `gap-report.test.ts`. FLF-172 P4. Gộp nhóm từ Spine/profile/draft thật ở
 * `test/integration/mode1/gap-report.int.test.ts`.
 */
import { describe, expect, it } from "vitest"
import { DocxPackage, readBlocks } from "../docx-ooxml/index.js"
import type { Flag } from "../spine/spine.types.js"
import { gapReportSchema, type GapReport } from "./import.dto.js"
import { formatReportTime, readableValue, renderGapReportDocx, titleOfSection } from "./gap-report.service.js"

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
  totals: { red: 1, yellow: 2, missing_sections: 1, unmapped_headings: 1, low_confidence_fields: 1, missing_fpt_sections: 2, unrendered_diagrams: 1 },
  missing_fpt_sections: [
    { section_id: "fixed:5.1", title: "Business Rules", step_id: "S-7.1", in_layout: false },
    { section_id: "fixed:4.2.4", title: "Domain-Specific Attributes", step_id: "S-6.5", in_layout: true }
  ],
  layout: [
    { order: 0, section_id: "fixed:1", heading: "1 Giới thiệu", level: 1, kind: "fpt", red: 0, yellow: 0 },
    { order: 1, section_id: "fixed:4.2.3", heading: "5.2 Hiệu năng", level: 2, kind: "fpt", red: 1, yellow: 1 },
    { order: 2, section_id: "custom:CS01", heading: "Phụ lục A Biên bản họp", level: 1, kind: "custom", red: 0, yellow: 0 }
  ],
  sections: [
    { section_id: "fixed:4.2.3", title: "Performance", flags: [flag("FL001", "red", "dead_reference", "fixed:4.2.3", "NFR trỏ UC-99"), flag("FL002", "yellow", "import_semantic", "fixed:4.2.3", "[ambiguity] 95% cần tải")] },
    { section_id: "feature:F-3.2", title: "Authentication", flags: [flag("FL003", "yellow", "empty_feature", "feature:F-3.2", "Feature rỗng")] }
  ],
  unrendered_diagrams: [{ diagram_id: "D-UC-01", kind: "usecase", section_id: "fixed:2.2.2", title: "Use Cases", reason: "not_rendered" }],
  missing_sections: [{ section_id: "fixed:3.1.1", title: "Screen Flow" }],
  unmapped_headings: [{ block_id: "B0045", text: "5.9 Team Notes" }],
  low_confidence_fields: [
    { section_id: "function:@B0031", path: "functions[id=FR-3.2.1].trigger", value: "Learner submits", confidence: 0.5, source_block_ids: ["B0032"], origin: "ai", confirmed: false }
  ]
})

const NL = String.fromCharCode(10)

const texts = async (buf: Buffer) => (await readBlocks(await DocxPackage.load(buf))).map((b) => ({ kind: b.kind, text: b.text }))

describe("renderGapReportDocx — xuất .docx mở được", () => {
  it("đọc lại bằng docx-ooxml: tiêu đề, bảng tổng quan, cờ theo mục (đỏ trước), mục thiếu, tiêu đề lạ, dữ liệu độ tin thấp", async () => {
    const buf = await renderGapReportDocx(REPORT, "Lumen")
    expect(buf.subarray(0, 4).toString("hex")).toBe("504b0304")
    const blocks = await texts(buf)
    const all = blocks.map((b) => b.text)
    expect(all[0]).toBe("Báo cáo thiếu sót — Lumen")
    expect(all[1]).toBe("Phiên bản tài liệu 0.0 · tạo lúc 19/09/2026 07:00")
    for (const h of ["Tổng quan", "Cờ theo mục", "Mục bắt buộc còn thiếu", "Tiêu đề không khớp mẫu", "Dữ liệu trích có độ tin thấp"]) expect(all).toContain(h)
    // tiêu đề mục không kèm khoá máy
    expect(all).toContain("Performance")
    expect(all).toContain("Authentication")
    const tables = blocks.filter((b) => b.kind === "table").map((b) => b.text)
    expect(tables[0]).toContain("Cờ đỏ | 1")
    expect(tables[0]).toContain("Cờ vàng | 2")
    expect(tables.find((t) => t.startsWith("Mức | Loại lỗi"))?.split(NL)).toEqual([
      "Mức | Loại lỗi | Nội dung",
      "Đỏ | Tham chiếu tới phần không tồn tại | NFR trỏ UC-99",
      "Vàng | AI phát hiện vấn đề nội dung | 95% cần tải"
    ])
    expect(tables.some((t) => t.includes("Screen Flow"))).toBe(true)
    expect(tables.some((t) => t.includes("5.9 Team Notes"))).toBe(true)
    expect(all.indexOf("Thiếu mục theo mẫu FPT")).toBeLessThan(all.indexOf("Cờ theo mục"))
    expect(tables.some((t) => t.includes("Business Rules | File không có | Bổ sung qua change request"))).toBe(true)
    expect(tables.some((t) => t.includes("Domain-Specific Attributes | Có tiêu đề, chưa có nội dung | Bổ sung qua change request"))).toBe(true)
    expect(tables.some((t) => t.includes("Phụ lục A Biên bản họp | Mục riêng (ngoài FPT) | 0 | 0"))).toBe(true)
    expect(tables.some((t) => t.includes("Chức năng FR-3.2.1 — Điều kiện kích hoạt | Learner submits | 50%"))).toBe(true)
  })

  it("không in mã máy: khoá section, block id, path Spine, mã luật, mã step, JSON", async () => {
    const text = (await texts(await renderGapReportDocx(REPORT, "Lumen"))).map((b) => b.text).join(NL)
    for (const raw of ["fixed:", "feature:", "custom:", "function:@", "B0", "[id=", "dead_reference", "import_semantic", "[ambiguity]", "S-7.1", "S-6.5", "D-UC-01", "usecase |"]) {
      expect(text).not.toContain(raw)
    }
  })

  it("báo cáo rỗng ⇒ câu 'không có' thay cho bảng, file vẫn hợp lệ", async () => {
    const empty = gapReportSchema.parse({
      ...REPORT,
      totals: { red: 0, yellow: 0, missing_sections: 0, unmapped_headings: 0, low_confidence_fields: 0, missing_fpt_sections: 0, unrendered_diagrams: 0 },
      missing_fpt_sections: [],
      layout: [],
      sections: [],
      unrendered_diagrams: [],
      missing_sections: [],
      unmapped_headings: [],
      low_confidence_fields: []
    })
    const all = (await texts(await renderGapReportDocx(empty, "Rỗng"))).map((b) => b.text)
    expect(all).toEqual(
      expect.arrayContaining(["Không có cờ nào đang mở.", "Không thiếu mục bắt buộc nào.", "Mọi tiêu đề đều khớp.", "Không có.", "Đủ mọi đầu mục mẫu FPT.", "Mọi hình đã có bản vẽ."])
    )
  })

  it("giá trị đã sửa (edited_value) thắng value; giá trị không phải chuỗi thành chữ dễ đọc, không JSON", async () => {
    const r = gapReportSchema.parse({
      ...REPORT,
      low_confidence_fields: [
        { ...REPORT.low_confidence_fields[0], edited_value: "Learner clicks Log in" },
        { ...REPORT.low_confidence_fields[0], path: "functions[id=FR-3.2.1].normal", value: ["a", "b"] },
        { ...REPORT.low_confidence_fields[0], path: "actors[]", value: { name: "Learner", kind: "human" } }
      ]
    })
    const tables = (await texts(await renderGapReportDocx(r, "Lumen"))).filter((b) => b.kind === "table").map((b) => b.text)
    const last = tables[tables.length - 1]
    expect(last).toContain("Learner clicks Log in")
    expect(last).not.toContain("Learner submits")
    expect(last).toContain("a, b")
    expect(last).not.toContain('["a","b"]')
    expect(last).toContain("Tên: Learner")
    expect(last).not.toContain("{")
  })
})

describe("readableValue / formatReportTime", () => {
  it("mảng, object, boolean ⇒ chữ", () => {
    expect(readableValue(["x", "y"])).toBe("x, y")
    expect(readableValue({ metric: "p95", threshold: "2 s" })).toBe(`Chỉ số đo: p95${NL}Ngưỡng: 2 s`)
    expect(readableValue(true)).toBe("Có")
    expect(readableValue(null)).toBe("")
  })
  it("giờ Việt Nam dd/mm/yyyy hh:mm", () => {
    expect(formatReportTime("2026-09-23T03:12:00.000Z")).toBe("23/09/2026 10:12")
  })
})

describe("titleOfSection", () => {
  const spine = { features: [{ id: "F-3.2", name: "Authentication" }], functions: [{ id: "FR-3.2.1", name: "Register account" }] } as never
  it("section cố định theo registry, feature/function theo tên trong Spine, không tìm thấy ⇒ nhãn chung (không in khoá)", () => {
    expect(titleOfSection(spine, "fixed:3.1.1")).toBe("Screens Flow")
    expect(titleOfSection(spine, "feature:F-3.2")).toBe("Authentication")
    expect(titleOfSection(spine, "function:FR-3.2.1")).toBe("Register account")
    expect(titleOfSection(spine, "function:FR-9")).toBe("Chức năng")
    expect(titleOfSection(spine, "feature:@B0012")).toBe("Tính năng")
    expect(titleOfSection(spine, "fixed:9.9")).toBe("Mục khác")
    expect(titleOfSection({ ...(spine as object), custom_sections: [{ id: "CS01", heading: "Phụ lục A" }] } as never, "custom:CS01")).toBe("Phụ lục A")
  })

  it("ưu tiên tiêu đề người dùng viết trong file (layout) hơn tên mẫu FPT", () => {
    const layout = [{ order: 0, heading_text: "3.1.1 Luồng màn hình", level: 3, section_id: "fixed:3.1.1" }]
    expect(titleOfSection(spine, "fixed:3.1.1", layout)).toBe("3.1.1 Luồng màn hình")
  })

  it("phần nối (mục riêng tiêu đề rỗng) hiện theo mục chủ khi có layout; không có layout ⇒ nói rõ là phần nối (nợ T5)", () => {
    const withCustom = { ...(spine as object), custom_sections: [{ id: "CS01", heading: "" }] } as never
    const layout = [
      { order: 0, heading_text: "1 Giới thiệu", level: 1, section_id: "fixed:1" },
      { order: 1, heading_text: "", level: 2, section_id: "custom:CS01" }
    ]
    expect(titleOfSection(withCustom, "custom:CS01", layout)).toBe('Phần nối của "1 Giới thiệu"')
    expect(titleOfSection(withCustom, "custom:CS01")).toBe("Phần nối (văn xuôi của mục trước)")
    // mục riêng không còn trong Spine (dữ liệu cũ) ⇒ nhãn chung, không in khoá
    expect(titleOfSection(spine, "custom:CS09", layout)).toBe("Mục riêng")
  })
})
