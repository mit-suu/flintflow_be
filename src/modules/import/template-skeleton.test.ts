import { describe, expect, it } from "vitest"
import JSZip from "jszip"
import { DocxPackage, readBlocks } from "../docx-ooxml/index.js"
import { NS } from "../docx-ooxml/xml.js"
import { imageRel, makeDocx, p, picture, styled, table } from "../docx-ooxml/testing/make-docx.js"
import { parseDocument } from "./parse.service.js"
import { makeSrsDocx } from "./testing/srs-fixture.js"
import {
  buildSkeleton,
  classifySection,
  genericSuggestion,
  isStandardWording,
  planSkeleton,
  isRecordHeaderRow,
  writeSkeletonDocx,
  type PendingDecision,
  type SkeletonOptions
} from "./template-skeleton.js"
import type { HeadingMapEntry } from "./template-profile.model.js"
import { PART_BANK } from "./part-bank.js"

/** Phần "Introduction" của ngân hàng phần (như matchProfile gắn cho heading Giới thiệu). */
const INTRO_PART = PART_BANK.find((part) => part.titles.some((t) => t.text === "Introduction"))!.id

const CUSTOMER = "Vietcombank"
const OPTS: SkeletonOptions = { projectName: CUSTOMER, language: "vi" }
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const GUIDE_FORMAT = `<w:rPr><w:i/><w:color w:val="0070C0"/></w:rPr>`

/** Mẫu thật của khách: bìa, header, docProps, comment, lịch sử, bảng khoá–giá trị, alt text, UC, mục riêng lồng nhau, ghi chú BA. */
const customerDocx = () =>
  makeDocx({
    body:
      p(`SRS — ${CUSTOMER} Core Banking`) +
      styled("u1", "Record of Changes") +
      table([["Date", "A/M/D", "Description"], ["2026-01-02", "A", `Bản đầu cho ${CUSTOMER}`]]) +
      styled("u1", `1 Introduction to ${CUSTOMER}`) +
      styled("u2", "1.1 Purpose") +
      p("[Describe the purpose of this document.]") +
      p(`[Lưu ý: ${CUSTOMER} yêu cầu OTP]`) +
      p(`This SRS describes the ${CUSTOMER} mobile banking app.`) +
      table([["Prepared by", "Nguyen Van A"], ["Approved by", "Tran Thi B"]]) +
      `<w:tbl><w:tblPr><w:tblCaption w:val="Bảng giá ${CUSTOMER}"/></w:tblPr><w:tblGrid/><w:tr><w:tc>${p("Term")}</w:tc><w:tc>${p("Meaning")}</w:tc></w:tr><w:tr><w:tc>${p("OTP")}</w:tc><w:tc>${p("One-time password")}</w:tc></w:tr></w:tbl>` +
      picture("rIdImg") +
      styled("u1", "3 Functional Requirements") +
      styled("u2", "3.1 Transfer money") +
      p("Users transfer money between accounts.") +
      styled("u2", `3.2 Tích hợp Core Banking ${CUSTOMER}`) +
      p("Gọi API T24 qua ESB.") +
      table([["Endpoint", "Owner"], ["/t24/transfer", "Nguyen Van A"]]) +
      `<w:p><w:pPr><w:pStyle w:val="MyH3"/></w:pPr><w:r><w:t>3.2.1 ESB của ${CUSTOMER}</w:t></w:r></w:p>` +
      styled("u1", "4 Non-functional Requirements") +
      `<w:p><w:r>${GUIDE_FORMAT}<w:t>[List quality attributes for ${CUSTOMER}.]</w:t></w:r></w:p>` +
      `<w:p><w:pPr><w:sectPr><w:headerReference w:type="default" r:id="rIdH"/></w:sectPr></w:pPr></w:p>`,
    sectPr: `<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="850" w:bottom="1134" w:left="1701"/></w:sectPr>`,
    extraDocRels:
      `<Relationship Id="rIdH" Type="${REL}/header" Target="header1.xml"/>` +
      `<Relationship Id="rIdC" Type="${REL}/comments" Target="comments.xml"/>` +
      `<Relationship Id="rIdS" Type="${REL}/settings" Target="settings.xml"/>` +
      imageRel("rIdImg", "media/logo.png"),
    extraContentTypes: `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>`,
    extraParts: {
      "word/header1.xml": `<w:hdr xmlns:w="${NS.w}">${p(`${CUSTOMER} — Confidential`)}</w:hdr>`,
      "word/comments.xml": `<w:comments xmlns:w="${NS.w}"><w:comment w:id="0" w:author="Nguyen Van A">${p(`Hỏi lại ${CUSTOMER}`)}</w:comment></w:comments>`,
      "word/settings.xml": `<w:settings xmlns:w="${NS.w}" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"><w:attachedTemplate r:id="rIdT" xmlns:r="${NS.r}"/><w:docVars><w:docVar w:name="client" w:val="${CUSTOMER}"/></w:docVars><w15:docId w15:val="{1234}"/><w:defaultTabStop w:val="720"/></w:settings>`,
      "docProps/core.xml": `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${CUSTOMER} SRS</dc:title></cp:coreProperties>`,
      "word/media/logo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47])
    }
  })

/** Mapping như Code đọc: lịch sử `fixed:I`, khung `group/slot/fixed`, UC `feature:*`, mục riêng `unmapped` (lồng nhau). */
const mapOf = async (buffer: Buffer) => {
  const { pkg, blocks } = await parseDocument(buffer)
  const id = (prefix: string) => blocks.find((b) => b.kind === "heading" && b.text.startsWith(prefix))!.block_id
  const block = (prefix: string) => blocks.find((b) => b.text.startsWith(prefix))!.block_id
  const e = (prefix: string, section_id: string, extra: Partial<HeadingMapEntry> = {}): HeadingMapEntry => ({
    block_id: id(prefix), heading_text: blocks.find((b) => b.block_id === id(prefix))!.text, section_id, confidence: 1, detected_by: "style", confirmed: true, ...extra
  })
  const map = [
    e("Record of Changes", "fixed:I"),
    e("1 Introduction", "fixed:1", { template_section: INTRO_PART }),
    // Hướng dẫn đánh dấu chỉ bằng ngoặc (không kiểu chữ) ⇒ không giữ; ghi chú BA trong ngoặc cũng vậy
    e("1.1 Purpose", "slot:vision", { guidance_blocks: [block("[Describe"), block("[Lưu ý")], guidance_by: "brackets" }),
    e("3 Functional", "group:3"),
    e("3.1 Transfer", "feature:@B0099"),
    e("3.2 Tích hợp", "unmapped"),
    e("3.2.1 ESB", "unmapped"),
    e("4 Non-functional", "fixed:4", { guidance_blocks: [block("[List quality")], guidance_by: "brackets+format" })
  ]
  // Bảng thuật ngữ Code nhận ra hàng tiêu đề; bảng khoá–giá trị và bảng của mục riêng không
  const glossary = blocks.filter((b) => b.kind === "table")[2].block_id
  return { pkg, blocks, map, tables: new Map([[glossary, ["Term", "Meaning"]]]) }
}

const allText = async (buffer: Buffer): Promise<string> => {
  const zip = await JSZip.loadAsync(buffer)
  return (await Promise.all(Object.values(zip.files).filter((f) => !f.dir).map((f) => f.async("string")))).join("\n")
}

const build = async (decisions: ReadonlyMap<string, PendingDecision> = new Map()) => {
  const source = await customerDocx()
  const { pkg, blocks, map, tables } = await mapOf(source)
  const plan = planSkeleton(blocks, map, tables, decisions, OPTS)
  return { plan, map, buffer: await writeSkeletonDocx(pkg, plan.items) }
}

describe("template-skeleton (FLF-395)", () => {
  it("classifySection + isStandardWording", () => {
    expect(classifySection({ section_id: "feature:@B0012" })).toBe("element")
    expect(classifySection({ section_id: "function:FN01" })).toBe("element")
    expect(classifySection({ section_id: "fixed:3.1.4" })).toBe("framework")
    expect(classifySection({ section_id: "unmapped", template_section: "part:ieee:conventions" })).toBe("framework")
    expect(classifySection({ section_id: "custom:CS02" })).toBe("custom")
    expect(isStandardWording("1 Introduction")).toBe(true)
    expect(isStandardWording("2.4 Document Conventions")).toBe(true)
    expect(isStandardWording(`1 Introduction to ${CUSTOMER}`)).toBe(false)
  })

  it("file khung không chứa chuỗi nào của khách (gồm cả các đường reviewer đã thử)", async () => {
    const { plan, buffer } = await build()
    const zip = await JSZip.loadAsync(buffer)
    expect(Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort()).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "word/_rels/document.xml.rels",
      "word/document.xml",
      "word/settings.xml",
      "word/styles.xml"
    ])
    const text = await allText(buffer)
    for (const leak of [CUSTOMER, "Nguyen Van A", "Tran Thi B", "Prepared by", "Transfer money", "2026-01-02", "T24", "ESB", "Confidential", "One-time", "OTP", "media/", "rIdH", "docVar", "docId", "attachedTemplate"]) {
      expect(text, leak).not.toContain(leak)
    }

    const blocks = await readBlocks(await DocxPackage.load(buffer))
    // Heading mẫu chuẩn có tên khách ⇒ chưa duyệt thì ghi tên chuẩn
    expect(blocks.filter((b) => b.kind === "heading").map((b) => [b.text, b.level])).toEqual([
      ["Record of Changes", 1],
      ["1 Introduction", 1],
      ["1.1 Purpose", 2],
      ["3 Functional Requirements", 1],
      ["4 Non-functional Requirements", 1]
    ])
    expect(blocks.filter((b) => b.kind === "table").map((b) => b.rows)).toEqual([[["Date", "A/M/D", "Description"]], [["Term", "Meaning"]]])
    // Chỉ hướng dẫn có kiểu chữ hướng dẫn, tên dự án thành chỗ trống
    expect(blocks.filter((b) => b.kind === "paragraph" && b.text).map((b) => b.text)).toEqual(["[List quality attributes for {Tên khách hàng}.]"])
    expect(await zip.file("word/document.xml")!.async("string")).toContain('w:left="1701"')
    expect(await zip.file("word/settings.xml")!.async("string")).toContain("defaultTabStop")

    expect(plan.review.map((r) => [r.heading_text, r.kind, r.standard_title])).toEqual([
      [`1 Introduction to ${CUSTOMER}`, "wording", "1 Introduction"],
      [`3.2 Tích hợp Core Banking ${CUSTOMER}`, "custom", null],
      // Mục riêng lồng trong mục riêng chưa duyệt vẫn hiện để duyệt
      [`3.2.1 ESB của ${CUSTOMER}`, "custom", null]
    ])
    expect(plan.waiting).toHaveLength(3)
  })

  it("duyệt: giữ chữ / dạng chung / bỏ; mục riêng được giữ chỉ có heading, không kéo bảng / chữ bên dưới", async () => {
    const { map } = await build()
    const key = (prefix: string) => map.find((h) => h.heading_text.startsWith(prefix))!.block_id
    const { plan, buffer } = await build(
      new Map<string, PendingDecision>([
        [key("1 Introduction"), { decision: "generic", text: "1 Introduction to {Tên khách hàng}" }],
        [key("3.2 Tích hợp"), { decision: "generic", text: "3.2 Tích hợp Core Banking {Tên khách hàng}" }],
        [key("3.2.1 ESB"), { decision: "drop" }]
      ])
    )
    expect(plan.waiting).toEqual([])
    const text = await allText(buffer)
    expect(text).toContain("1 Introduction to {Tên khách hàng}")
    expect(text).toContain("3.2 Tích hợp Core Banking {Tên khách hàng}")
    for (const leak of [CUSTOMER, "T24", "/t24/transfer", "Endpoint", "ESB"]) expect(text, leak).not.toContain(leak)
  })

  it("dấu khung tính cả heading còn chờ: hai dự án khác mục riêng không trùng; nội dung khác không đổi dấu", async () => {
    const make = async (custom: string, body: string) => {
      const buffer = await makeSrsDocx({ extraBody: styled("u1", custom) + p(body) })
      return (await buildSkeleton(buffer, { projectName: "Lumen", language: "en" })).hash
    }
    expect(await make("9 Payroll Notes", "A")).toBe(await make("9 Payroll Notes", "B"))
    expect(await make("9 Payroll Notes", "A")).not.toBe(await make("9 Warehouse Notes", "A"))
  })

  it("buildSkeleton trên SRS mẫu: bỏ heading tính năng / chức năng, khung có heading, không chứa nội dung", async () => {
    const built = await buildSkeleton(await makeSrsDocx(), { projectName: "Lumen", language: "en" })
    expect(built.empty).toBe(false)
    expect(built.headings.every((h) => !h.section_id.startsWith("feature:") && !h.section_id.startsWith("function:"))).toBe(true)
    const blocks = await readBlocks(await DocxPackage.load(built.buffer))
    expect(blocks.filter((b) => b.kind === "table").every((t) => t.rows?.length === 1)).toBe(true)
  })

  it("buildSkeleton (đường thật, matchProfile tự đọc bảng): bảng khoá–giá trị / đặc tả không mang chữ khách; tên dự án trong tiêu đề cột thành chỗ trống", async () => {
    const buffer = await makeSrsDocx({
      extraBody:
        styled("u1", "9 Document Conventions") +
        table([["Prepared by", "Nguyen Van A"], ["Approved by", "Tran Thi B"]]) +
        table([["UC ID and Name:", "UC-07 Chuyển tiền Lumen"], ["Created By:", "Le Van C"]]) +
        table([["Lumen Term", "Meaning"], ["OTP", "One-time password"]])
    })
    const built = await buildSkeleton(buffer, { projectName: "Lumen", language: "en" })
    const text = await allText(built.buffer)
    for (const leak of ["Nguyen Van A", "Tran Thi B", "Le Van C", "UC-07", "Chuyển tiền", "One-time password", "Lumen"]) expect(text, leak).not.toContain(leak)
    const blocks = await readBlocks(await DocxPackage.load(built.buffer))
    for (const t of blocks.filter((b) => b.kind === "table")) {
      expect(t.rows).toHaveLength(1)
      // Ô có chữ chỉ là tiêu đề cột Code đã ánh xạ
      expect(t.rows![0].every((c) => !/\d/.test(c))).toBe(true)
    }
  })

  it("isRecordHeaderRow: hàng tiêu đề lịch sử nhận, dòng dữ liệu (ngày, tên người, mô tả) không nhận", () => {
    expect(isRecordHeaderRow(["Date", "A*, M, D", "In charge", "Change Description"])).toBe(true)
    expect(isRecordHeaderRow(["Ngày", "Phiên bản", "Người thay đổi", "Mô tả"])).toBe(true)
    expect(isRecordHeaderRow(["2026-01-02", "A", "Nguyen Van A", "Bản đầu"])).toBe(false)
    expect(isRecordHeaderRow(["", "A", "Nguyen Van A", "Change login flow"])).toBe(false)
    expect(isRecordHeaderRow(["", ""])).toBe(false)
  })

  it("heading đúng tên chuẩn không bị thay tên dự án (dự án tên trùng một từ của tên chuẩn)", async () => {
    const built = await buildSkeleton(await makeSrsDocx(), { projectName: "Requirements", language: "en" })
    expect(built.headings.some((h) => h.heading_text.includes("{Customer name}"))).toBe(false)
  })

  it("genericSuggestion thay tên dự án bằng chỗ trống theo ngôn ngữ; không có tên ⇒ null", () => {
    expect(genericSuggestion("Tích hợp Core Banking Vietcombank", "vietcombank", "vi")).toBe("Tích hợp Core Banking {Tên khách hàng}")
    expect(genericSuggestion("Integration with ACME", "ACME", "en")).toBe("Integration with {Customer name}")
    expect(genericSuggestion("Payment gateway", "ACME", "en")).toBeNull()
  })
})
