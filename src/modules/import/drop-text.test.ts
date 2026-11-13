import { describe, expect, it } from "vitest"
import JSZip from "jszip"
import { VI_HEADING_STYLES, imageRel, makeDocx, p, styled, table } from "../docx-ooxml/testing/make-docx.js"
import { DocxPackage } from "../docx-ooxml/index.js"
import { validateDocxStructure } from "../template-migration/ooxml-transplant.js"
import { applyDropToBlocks, applyDropToDom, cleanupDroppedPackage, planDrop, textRegions, validDropKeys, type DropBlock } from "./drop-text.js"
import { parseDocument } from "./parse.service.js"
import { autoConfirmMapping, matchProfile } from "./profile-match.service.js"

const h = (block_id: string, text: string, level = 1): DropBlock => ({ block_id, kind: "heading", level, text })
const para = (block_id: string, text: string): DropBlock => ({ block_id, kind: "paragraph", text })

/** Mẫu lấy từ dự án cũ: mục khung còn chữ, mục chỉ có hướng dẫn, tính năng cũ dưới mục chức năng, mục BA tự đặt. */
const BLOCKS: DropBlock[] = [
  para("B0001", "SRS - Old Bank"),
  h("B0002", "1 Introduction"),
  para("B0003", "[Describe the purpose of this document.]"),
  para("B0004", "Old Bank needs an internet banking portal."),
  h("B0005", "2 Functional Requirements"),
  h("B0006", "2.1 Transfer money", 2),
  para("B0007", "The customer transfers money between accounts."),
  { block_id: "B0008", kind: "table", text: "", rows: [["Field", "Rule"], ["Amount", "> 0"]] },
  h("B0009", "3 Non-functional Requirements"),
  para("B0010", "[List performance requirements.]"),
  h("B0011", "4 Core Banking Integration"),
  para("B0012", "Old Bank core runs on T24.")
]

const HEADINGS = [
  { block_id: "B0002", section_id: "fixed:1", heading_text: "1 Introduction", template_section: null },
  { block_id: "B0005", section_id: "group:3", heading_text: "2 Functional Requirements", template_section: null },
  { block_id: "B0006", section_id: "feature:@B0006", heading_text: "2.1 Transfer money", template_section: null },
  { block_id: "B0009", section_id: "fixed:4", heading_text: "3 Non-functional Requirements", template_section: null },
  { block_id: "B0011", section_id: "unmapped", heading_text: "4 Core Banking Integration", template_section: null }
]

describe("textRegions", () => {
  it("chia vùng theo heading khung; heading phần tử + thân thuộc vùng đang mở; bìa không thuộc vùng nào", () => {
    const regions = textRegions(BLOCKS, HEADINGS)
    expect(regions.map((r) => [r.key, r.has_text, r.custom])).toEqual([
      ["B0002", true, false],
      ["B0005", true, false],
      ["B0009", false, false],
      ["B0011", true, true]
    ])
    expect(regions[1].block_ids).toEqual(["B0006", "B0007", "B0008"])
  })

  it("lựa chọn chỉ nhận vùng có chữ", () => {
    expect(validDropKeys(textRegions(BLOCKS, HEADINGS), ["B0002", "B0009", "B9999", "B0002"])).toEqual(["B0002"])
  })
})

describe("planDrop", () => {
  const regions = textRegions(BLOCKS, HEADINGS)
  const all = new Set(regions.map((r) => r.key))

  it("vùng bỏ chữ chỉ giữ heading + chữ hướng dẫn; heading phần tử và mọi thứ dưới nó bị bỏ", () => {
    const after = applyDropToBlocks(BLOCKS, planDrop(BLOCKS, regions, all, "fixed"))
    expect(after.map((b) => b.block_id)).toEqual(["B0001", "B0002", "B0003", "B0005", "B0009", "B0010", "B0011"])
  })

  it("bảng ngay dưới heading khung giữ hàng tiêu đề + một hàng trống (dạng bảng của khung mẫu); bảng một hàng (khung) giữ nguyên", () => {
    const blocks: DropBlock[] = [h("B0001", "1 Actors"), { block_id: "B0002", kind: "table", text: "", rows: [["Actor", "Description"], ["Teller", "Bank staff"]] }]
    const heads = [{ block_id: "B0001", section_id: "fixed:2.1", heading_text: "1 Actors", template_section: null }]
    const after = applyDropToBlocks(blocks, planDrop(blocks, textRegions(blocks, heads), new Set(["B0001"]), "fixed"))
    expect(after[1].rows).toEqual([["Actor", "Description"], ["", ""]])
    expect(textRegions(after, heads)[0].has_text).toBe(false)
    const frame: DropBlock[] = [h("B0001", "1 Actors"), { block_id: "B0002", kind: "table", text: "", rows: [["Actor", "Description"]] }]
    expect(textRegions(frame, heads)[0].has_text).toBe(false)
  })

  it("mẫu chuẩn FlintFlow (free): mục BA tự đặt bỏ cả heading — không được soạn lại nên không để heading trống", () => {
    const plan = planDrop(BLOCKS, regions, new Set(["B0011"]), "free")
    expect([...plan.remove]).toEqual(["B0011", "B0012"])
    const kept = planDrop(BLOCKS, regions, new Set(["B0011"]), "fixed")
    expect([...kept.remove]).toEqual(["B0012"])
  })

  it("vùng giữ nội dung không đổi gì", () => {
    const plan = planDrop(BLOCKS, regions, new Set(["B0002"]), "fixed")
    expect([...plan.remove]).toEqual(["B0004"])
  })
})

describe("applyDropToDom — viết lại file", () => {
  it("file sau khi bỏ chữ chỉ còn khung; tách lại ra đúng các khối còn lại, giữ khoá block", async () => {
    const source = await makeDocx({
      styles: VI_HEADING_STYLES,
      body:
        styled("u1", "1 Introduction") +
        p("[Describe the purpose of this document.]") +
        p("Old Bank needs an internet banking portal.") +
        styled("u1", "2 Overall Description") +
        p("Old Bank serves retail customers.") +
        table([["Actor", "Description"], ["Teller", "Old Bank staff"]])
    })
    const { pkg, blocks } = await parseDocument(source)
    const matched = matchProfile(blocks, { fixedTemplate: false })
    autoConfirmMapping(matched)
    const regions = textRegions(blocks, matched.heading_map)
    expect(regions.filter((r) => r.has_text)).toHaveLength(2)
    applyDropToDom(blocks, planDrop(blocks, regions, new Set(regions.map((r) => r.key)), "fixed"))
    const rewritten = await pkg.toBuffer()

    const xml = await (await JSZip.loadAsync(rewritten)).file("word/document.xml")!.async("string")
    expect(xml).not.toContain("Old Bank")
    expect(xml).toContain("[Describe the purpose of this document.]")
    expect(xml).toContain("Actor")

    const again = await parseDocument(rewritten)
    const headingIds = (bs: typeof blocks) => bs.filter((b) => b.kind === "heading").map((b) => b.block_id)
    expect(headingIds(again.blocks)).toEqual(headingIds(blocks))
    expect(textRegions(again.blocks, matched.heading_map).some((r) => r.has_text)).toBe(false)
  })
})

describe("applyDropToDom — đoạn dùng chung nhiều khối, ảnh trong ô bảng", () => {
  const drawing = (rid: string) => `<w:r><w:drawing><a:blip xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" r:embed="${rid}"/></w:drawing></w:r>`

  it("heading gõ chung đoạn giữ chữ heading; chữ hướng dẫn kèm ảnh cũ giữ chữ, bỏ ảnh; ảnh trong ô bảng không làm hỏng file; ảnh mồ côi bị dọn", async () => {
    const source = await makeDocx({
      styles: VI_HEADING_STYLES,
      body:
        styled("u1", "1 Introduction") +
        `<w:p><w:r><w:t>1.1 Purpose</w:t></w:r><w:r><w:br/><w:t>Old Bank wants an internet banking portal.</w:t></w:r></w:p>` +
        styled("u1", "2 Screen Flow") +
        `<w:p><w:r><w:t>[Insert the screen flow here.]</w:t></w:r>${drawing("rIdOld")}</w:p>` +
        p("Old Bank screens go here.") +
        styled("u1", "3 Screens") +
        `<w:tbl><w:tblPr/><w:tblGrid/><w:tr><w:tc>${p("Screen")}</w:tc><w:tc>${p("Image")}</w:tc></w:tr><w:tr><w:tc>${p("Login of Old Bank")}</w:tc><w:tc><w:p>${drawing("rIdOld2")}</w:p></w:tc></w:tr></w:tbl>`,
      extraDocRels: imageRel("rIdOld", "old.png") + imageRel("rIdOld2", "old2.png"),
      extraParts: { "word/media/old.png": Buffer.from([0x89, 0x50, 0x4e, 0x47]), "word/media/old2.png": Buffer.from([0x89, 0x50, 0x4e, 0x47]) }
    })
    const { pkg, blocks } = await parseDocument(source)
    // Parser tách heading gõ chung đoạn + đoạn chữ / ảnh thành nhiều khối trên cùng một <w:p>
    expect(blocks.filter((b) => b.text === "1.1 Purpose" || b.text.startsWith("Old Bank wants")).map((b) => b.element)).toHaveLength(2)
    expect(new Set(blocks.filter((b) => b.text === "1.1 Purpose" || b.text.startsWith("Old Bank wants")).map((b) => b.element)).size).toBe(1)
    const matched = matchProfile(blocks, { fixedTemplate: false })
    autoConfirmMapping(matched)
    const regions = textRegions(blocks, matched.heading_map)
    applyDropToDom(blocks, planDrop(blocks, regions, new Set(regions.map((r) => r.key)), "fixed"))
    await cleanupDroppedPackage(pkg)
    const rewritten = await pkg.toBuffer()

    const reloaded = await DocxPackage.load(rewritten)
    expect(await validateDocxStructure(reloaded)).toEqual([])
    const zip = await JSZip.loadAsync(rewritten)
    const xml = await zip.file("word/document.xml")!.async("string")
    expect(xml).toContain("1.1 Purpose")
    expect(xml).toContain("[Insert the screen flow here.]")
    expect(xml).not.toContain("Old Bank")
    expect(xml).not.toContain("r:embed")
    expect(zip.file("word/media/old.png")).toBeNull()
    expect(zip.file("word/media/old2.png")).toBeNull()
    expect(xml).toContain("Screen")
  })
})
