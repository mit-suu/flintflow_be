/**
 * FLF-468 — tích hợp không AI: dựng DOCX giả lập dự án "Upload SRS có sẵn" đi trọn đường thật (buildLayoutSections ⇒
 * source-fidelity ⇒ writeTemplateDocx), không qua DB / AI. Kiểm 3 lát A, B, D cùng lúc trên MỘT file:
 * - CR xoá chức năng "Xuất thời khóa biểu ra Excel" ⇒ mục biến mất khỏi 1.0 (lát A — B3).
 * - CR sửa / xoá / thêm thông báo (bảng §5.3 nguyên văn, không phần tử nào gắn vào đoạn nào lúc import, như ChoViet)
 *   ⇒ vẫn một bảng 5 cột như file gốc, đúng hàng (lát B).
 * - Mục không bị CR chạm (Phụ lục) ⇒ giữ nguyên văn tuyệt đối.
 */
import JSZip from "jszip"
import { describe, expect, it } from "vitest"
import { NS } from "../docx-ooxml/xml.js"
import { parseDocument } from "../import/parse.service.js"
import { createEmptySpine } from "../spine/spine.repository.js"
import type { Spine } from "../spine/spine.types.js"
import { buildLayoutSections, type TemplateLayout } from "./layout-sections.js"
import { fidelityFrom } from "./source-fidelity.js"
import { writeTemplateDocx } from "./template-docx-writer.js"
import type { RenderedDocument } from "./rendered-document.types.js"

const styles = `<w:styles xmlns:w="${NS.w}"><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>`
const heading = (text: string, level: number) => `<w:p><w:pPr><w:pStyle w:val="Heading${level}"/><w:keepNext/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>${text}</w:t></w:r></w:p>`
const para = (text: string) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
const cell = (text: string) => `<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr>${para(text)}</w:tc>`
const row = (...cells: string[]) => `<w:tr>${cells.map(cell).join("")}</w:tr>`
const messageRows: readonly string[][] = [
  ["Mã", "Kiểu", "Ngữ cảnh", "Nội dung"],
  ["CHAT-001", "error", "Chat", "Không gửi được tin nhắn."],
  ["PAY-010", "error", "Payment", "Không đủ số dư."]
]
const messageTable = `<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/></w:tblPr><w:tblGrid>${"<w:gridCol w:w=\"2250\"/>".repeat(4)}</w:tblGrid>${messageRows.map((r) => row(...r)).join("")}</w:tbl>`

async function templateDocx(): Promise<Buffer> {
  const zip = new JSZip()
  zip.file("[Content_Types].xml", `<Types xmlns="${NS.ct}"><Default Extension="xml" ContentType="application/xml"/></Types>`)
  zip.file(
    "word/document.xml",
    `<w:document xmlns:w="${NS.w}"><w:body>` +
      heading("Xuất thời khóa biểu ra Excel", 2) +
      para("Xuất lịch học của sinh viên ra file Excel.") +
      heading("Thông báo", 2) +
      messageTable +
      heading("Phụ lục", 1) +
      para("Ghi chú không đổi.") +
      `<w:sectPr><w:pgMar w:top="1134" w:left="1134"/></w:sectPr></w:body></w:document>`
  )
  zip.file("word/styles.xml", styles)
  return zip.generateAsync({ type: "nodebuffer" })
}

const fn = (overrides: Partial<Spine["functions"][number]> = {}): Spine["functions"][number] => ({
  id: "FN-EXCEL", feature_id: "F1", screen_id: null, order: 0, name: "Xuất thời khóa biểu ra Excel",
  trigger: "", description: "Xuất lịch học của sinh viên ra file Excel.", normal: [], abnormal: [], validations: [],
  business_rule_ids: [], priority: null, ...overrides
})

const baseSpine = (): Spine => ({
  ...createEmptySpine({ name: "EduCampus" }),
  functions: [fn()],
  messages: [
    { id: "MSG-CHAT1", code: "CHAT-001", text: "Không gửi được tin nhắn.", function_ids: [], type: "error", context: "Chat" },
    { id: "MSG-PAY", code: "PAY-010", text: "Không đủ số dư.", function_ids: [], type: "error", context: "Payment" }
  ],
  custom_sections: [
    { id: "MSGTBL", heading: "", level: 3, source: "import", blocks: [{ kind: "table", text: "", rows: [...messageRows], image_ref: null }] },
    { id: "APPX", heading: "Phụ lục", level: 1, source: "import", blocks: [{ kind: "paragraph", text: "Ghi chú không đổi.", rows: null, image_ref: null }] }
  ]
})

const template: TemplateLayout = {
  language: "vi",
  // Mẫu cố định (ChoViet là template_intent: fixed — plan): chỉ in đúng các mục của mẫu, không tự chèn thêm mục FPT
  // mặc định mà fixture tối giản này không có (fixed:1, fixed:2.1…).
  fixedTemplate: true,
  layout: [
    { order: 0, heading_text: "Xuất thời khóa biểu ra Excel", level: 2, section_id: "function:FN-EXCEL" },
    // Chưa rebind — như layout thật lúc import (heading "Thông báo" khớp mẫu ⇒ bindFixedTemplateSlots gán lại thành
    // slot:messages lúc build; order giữ nguyên để writer/slot tra lại đúng custom_sections gốc, xem layout-sections.ts)
    { order: 1, heading_text: "Thông báo", level: 2, section_id: "custom:MSGTBL" },
    { order: 2, heading_text: "Phụ lục", level: 1, section_id: "custom:APPX" }
  ]
}

const renderDoc = (sp: Spine): RenderedDocument => ({
  projectId: "p", projectName: "EduCampus", version: "1.0", source: "draft", generatedAt: "2026-11-24T00:00:00Z", recordOfChanges: [],
  sections: buildLayoutSections(sp, template, [], { diagramPng: () => undefined }).sections
})

describe("FLF-468 — tích hợp không AI: xuất 1.0 sau CR xoá chức năng + sửa/xoá/thêm thông báo", () => {
  it("mục 3.4.3 biến mất, bảng thông báo vá đúng hàng (1 bảng, đúng 5 cột), Phụ lục giữ nguyên văn tuyệt đối", async () => {
    const input = await templateDocx()
    const parsed = await parseDocument(input)
    const headingMap = parsed.blocks.filter((b) => b.kind === "heading").map((b) => ({
      block_id: b.block_id,
      section_id: b.text === "Xuất thời khóa biểu ra Excel" ? "function:FN-EXCEL" : b.text === "Thông báo" ? "slot:messages" : "custom:APPX"
    }))
    expect(headingMap).toHaveLength(3)

    const spineBefore = baseSpine()
    const spineAfter: Spine = {
      ...baseSpine(),
      functions: [], // CR xoá "Xuất thời khóa biểu ra Excel"
      messages: [
        // CHAT-001 (MSG-CHAT1) đã bị xoá; PAY-010 sửa nội dung; PAY-020 là thông báo mới
        { id: "MSG-PAY", code: "PAY-010", text: "Số dư không đủ để thanh toán.", function_ids: [], type: "error", context: "Payment" },
        { id: "MSG-PAY2", code: "PAY-020", text: "Giao dịch đang xử lý.", function_ids: [], type: "info", context: "Payment" }
      ]
    }

    const importedDoc = renderDoc(spineBefore)
    const currentDoc = renderDoc(spineAfter)
    const fidelity = await fidelityFrom(currentDoc, async () => importedDoc, spineBefore, false)

    const output = await writeTemplateDocx(currentDoc, input, headingMap, [], {
      keepSource: fidelity.keepSource,
      importedSectionIds: fidelity.importedSectionIds,
      legacyRecordCount: 0
    })
    const result = await parseDocument(output)
    const texts = result.blocks.map((b) => b.text)

    // Lát A: mục của chức năng đã xoá biến mất hẳn (heading + thân)
    expect(texts).not.toContain("Xuất thời khóa biểu ra Excel")
    expect(texts.some((t) => t.includes("Xuất lịch học"))).toBe(false)

    // Lát B: đúng MỘT bảng thông báo, đúng cột của file, đúng hàng sau CR — không "bảng thứ hai", không "Mã: ..."
    const tables = result.blocks.filter((b) => b.kind === "table")
    expect(tables).toHaveLength(1)
    expect(tables[0].rows).toEqual([
      ["Mã", "Kiểu", "Ngữ cảnh", "Nội dung"],
      ["PAY-010", "error", "Payment", "Số dư không đủ để thanh toán."],
      ["PAY-020", "info", "Payment", "Giao dịch đang xử lý."]
    ])
    expect(texts.some((t) => t.includes("Mã:") || t.includes("CHAT-001"))).toBe(false)

    // Mục không bị CR chạm: giữ nguyên văn
    expect(texts).toContain("Phụ lục")
    expect(texts).toContain("Ghi chú không đổi.")
  })
})
