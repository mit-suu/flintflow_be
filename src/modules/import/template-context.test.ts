import { describe, expect, it } from "vitest"
import type { CustomBlock } from "../spine/spine.types.js"
import type { LayoutEntry } from "./template-profile.model.js"
import { buildTemplateContext, classifyPassages, looksLikeExample, templatePromptBlock } from "./template-context.js"

const para = (text: string): CustomBlock => ({ kind: "paragraph", text, rows: null, image_ref: null })
const table = (rows: string[][]): CustomBlock => ({ kind: "table", text: "", rows, image_ref: null })
const entry = (order: number, section_id: string, heading_text: string, extra: Partial<LayoutEntry> = {}): LayoutEntry => ({ order, section_id, heading_text, level: 1, ...extra })

describe("FLF-378 template-context — chữ trong mẫu là hướng dẫn / ví dụ / ngữ cảnh", () => {
  it("luật tất định: dấu hiệu ví dụ / chỗ điền", () => {
    expect(looksLikeExample("Ví dụ: Hệ thống quản lý thư viện")).toBe(true)
    expect(looksLikeExample("e.g. FR-001 The user logs in")).toBe(true)
    expect(looksLikeExample("Người phê duyệt: Nguyễn Văn A")).toBe(true)
    expect(looksLikeExample("Hệ thống XYZ hỗ trợ thủ thư")).toBe(true)
    expect(looksLikeExample("Kho hàng Minh Phát có ba chi nhánh.")).toBe(false)
  })

  it("buildTemplateContext: hướng dẫn trong ngoặc, đoạn ví dụ / chưa rõ, cột + dòng mẫu của bảng; heading rỗng bỏ qua", () => {
    const layout = [
      entry(0, "fixed:1", "1 Giới thiệu", { template_guidance: ["[Mô tả mục đích tài liệu]"] }),
      entry(1, "custom:CS01", ""),
      entry(2, "custom:CS02", "Dự toán")
    ]
    const ctx = buildTemplateContext(layout, [
      { section_id: "fixed:1", block: para("Ví dụ: Hệ thống quản lý thư viện giúp thủ thư.") },
      { section_id: "fixed:1", block: para("Kho hàng Minh Phát có ba chi nhánh {ghi tên chi nhánh}.") },
      { section_id: "custom:CS02", block: table([["Hạng mục", "Chi phí"], ["[Tên hạng mục]", "10.000.000"]]) }
    ])
    expect(ctx.map((c) => c.section_id)).toEqual(["fixed:1", "custom:CS02"])
    expect(ctx[0].guidance).toEqual(["ghi tên chi nhánh", "Mô tả mục đích tài liệu"])
    expect(ctx[0].passages).toEqual([
      { text: "Ví dụ: Hệ thống quản lý thư viện giúp thủ thư.", kind: "example" },
      { text: "Kho hàng Minh Phát có ba chi nhánh.", kind: "unclassified" }
    ])
    expect(ctx[1]).toMatchObject({ table_columns: [["Hạng mục", "Chi phí"]], guidance: ["Tên hạng mục"], passages: [{ text: "10.000.000", kind: "example" }] })
  })

  it("classifyPassages: ví dụ 'quản lý thư viện' trong dự án quản lý kho ⇒ example; đoạn nhắc đúng dự án ⇒ context", () => {
    const passages = [
      { text: "Hệ thống quản lý thư viện cho phép mượn trả sách", kind: "unclassified" as const },
      { text: "Phần mềm Quản lý kho Minh Phát theo dõi nhập xuất tồn", kind: "unclassified" as const },
      { text: "Kho hàng có ba chi nhánh, theo dõi nhập xuất hằng ngày", kind: "unclassified" as const }
    ]
    const out = classifyPassages(passages, { name: "Quản lý kho Minh Phát", texts: ["Theo dõi nhập xuất hằng ngày của kho hàng"] })
    expect(out.map((p) => p.kind)).toEqual(["example", "context", "context"])
    // Chưa có thông tin dự án ⇒ giữ nguyên
    expect(classifyPassages(passages, {}).every((p) => p.kind === "unclassified")).toBe(true)
  })

  it("templatePromptBlock: đủ nhãn Template guidance / example (không chép) / context, cột bảng, nội dung nên có", () => {
    const text = templatePromptBlock(
      [
        {
          section_id: "fixed:1",
          heading: "1 Giới thiệu",
          guidance: ["Mô tả mục đích"],
          passages: [
            { text: "Ví dụ: Hệ thống quản lý thư viện", kind: "example" },
            { text: "Quản lý kho Minh Phát phục vụ ba chi nhánh", kind: "unclassified" }
          ],
          table_columns: [["ID", "Mô tả"]]
        }
      ],
      { name: "Quản lý kho Minh Phát" },
      (id) => (id === "fixed:1" ? "purpose, scope" : null)
    )
    expect(text).toContain("Template guidance:\n- Mô tả mục đích")
    expect(text).toContain("Template example (style and structure only — DO NOT copy")
    expect(text).toContain("Template context (customer background")
    expect(text).toContain("- Quản lý kho Minh Phát phục vụ ba chi nhánh")
    expect(text).toContain("Template table columns (keep these columns and their order):\n- ID | Mô tả")
    expect(text).toContain("Should contain (ISO/IEC/IEEE 29148): purpose, scope")
    expect(templatePromptBlock([], {})).toBe("")
  })
})
