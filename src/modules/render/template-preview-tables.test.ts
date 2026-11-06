import { describe, expect, it } from "vitest"
import type { TableMapEntry } from "../import/template-profile.model.js"
import type { RenderedDocument, RenderedSection } from "./rendered-document.types.js"
import { projectPreviewTables, type SourceBlock } from "./template-preview-tables.js"

const cell = (text: string) => [{ text }]
const section = (id: string, level: number, header: string[], rows: string[][]): RenderedSection =>
  ({ id, number: "", heading: id, level, blocks: [{ type: "table", header: header.map(cell), rows: rows.map((r) => r.map(cell)) }] }) as unknown as RenderedSection
const doc = (sections: RenderedSection[]): RenderedDocument =>
  ({ projectId: "P", projectName: "Demo", version: "v0.1", source: "draft", generatedAt: "", sections, recordOfChanges: [] }) as unknown as RenderedDocument
const map = (block_id: string, headers: string[], fields: (string | null)[]): TableMapEntry[] =>
  headers.map((header, column_index) => ({ block_id, column_index, header, field_path: fields[column_index], confidence: 1, confirmed: true }) as TableMapEntry)

const headers = (d: RenderedDocument, i = 0) => (d.sections[i].blocks[0] as { header: { text: string }[][] }).header.map((c) => c.map((r) => r.text).join(""))
const rows = (d: RenderedDocument, i = 0) => (d.sections[i].blocks[0] as { rows: { text: string }[][][] }).rows.map((r) => r.map((c) => c.map((x) => x.text).join("")))

describe("projectPreviewTables (FLF-379 — xem trước mẫu cố định đúng cột như bản xuất)", () => {
  const blocks: SourceBlock[] = [
    { block_id: "H1", kind: "heading" },
    { block_id: "T1", kind: "table", rows: [["Mã", "Tên tài liệu", "Đơn vị", "Loại"], ["[REF-xx]", "[Tên]", "[Đơn vị]", "[Loại]"]] },
    { block_id: "H2", kind: "heading" },
    { block_id: "T2", kind: "table", rows: [["Thuật ngữ", "Định nghĩa"]] }
  ]
  const headingMap = [{ block_id: "H1", section_id: "slot:references" }, { block_id: "H2", section_id: "fixed:5.5" }]
  const tableMap = [
    ...map("T1", ["Mã", "Tên tài liệu", "Đơn vị", "Loại"], ["references[].id", "references[].title", "references[].owner", "references[].kind"]),
    ...map("T2", ["Thuật ngữ", "Định nghĩa"], ["glossary[].term", "glossary[].definition"])
  ]

  it("bảng FlintFlow thừa cột (Phiên bản / Ngày / Nơi lưu; Tiếng Việt) ⇒ chỉ còn cột của file, đúng thứ tự file", () => {
    const input = doc([
      section("slot:references", 2, ["Mã", "Tên tài liệu", "Đơn vị", "Phiên bản", "Ngày", "Nơi lưu", "Loại"], [["REF-01", "ISO 29148", "ISO", "", "", "", "Tham khảo"]]),
      section("fixed:5.5", 2, ["Thuật ngữ", "Tiếng Việt", "Định nghĩa"], [["SRS", "", "Đặc tả yêu cầu"]])
    ])
    const out = projectPreviewTables(input, blocks, headingMap, tableMap)
    expect(headers(out, 0)).toEqual(["Mã", "Tên tài liệu", "Đơn vị", "Loại"])
    expect(rows(out, 0)).toEqual([["REF-01", "ISO 29148", "ISO", "Tham khảo"]])
    expect(headers(out, 1)).toEqual(["Thuật ngữ", "Định nghĩa"])
    expect(rows(out, 1)).toEqual([["SRS", "Đặc tả yêu cầu"]])
  })

  it("mục không có bảng trong file / không có table_map ⇒ giữ nguyên bảng FlintFlow", () => {
    const input = doc([section("fixed:2.1", 2, ["Tác nhân", "Mô tả"], [["Admin", "Quản trị"]])])
    expect(projectPreviewTables(input, blocks, headingMap, tableMap)).toBe(input)
    const refs = doc([section("slot:references", 2, ["Mã", "Tên tài liệu", "Phiên bản"], [["REF-01", "ISO", "1.0"]])])
    expect(projectPreviewTables(refs, blocks, headingMap, [])).toBe(refs)
  })
})
