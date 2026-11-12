/**
 * Fixture dựng file nền cho test (và để xuất mẫu mở thử bằng Word): file v1 (nguồn, style bản địa hoá) và mẫu v2 (đích, style chuẩn).
 * Chỉ dùng trong test — dựng .docx tối thiểu bằng `makeDocx`, không đụng Mongo.
 */
import { makeDocx, p } from "../docx-ooxml/testing/make-docx.js"
import { NS } from "../docx-ooxml/xml.js"
import { makePng } from "../render/zip.test-helper.js"
import type { MigrationGroups } from "./classify.js"
import type { NewHeading, OldHeading, PairingResult } from "./pair-sections.js"

const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const CT = "application/vnd.openxmlformats-officedocument.wordprocessingml"
const rel = (id: string, type: string, target: string, external = false) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"${external ? ' TargetMode="External"' : ""}/>`
const part = (xml: string, root: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:${root} xmlns:w="${NS.w}" xmlns:r="${NS.r}">${xml}</w:${root}>`

const STYLES_V1 =
  `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>` +
  `<w:style w:type="paragraph" w:styleId="u1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/></w:style>` +
  `<w:style w:type="paragraph" w:styleId="u2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/></w:style>` +
  `<w:style w:type="paragraph" w:styleId="Dsach"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/></w:style>` +
  `<w:style w:type="paragraph" w:styleId="Ghichu"><w:name w:val="footnote text"/><w:basedOn w:val="Normal"/></w:style>` +
  `<w:style w:type="character" w:styleId="KyTu"><w:name w:val="footnote reference"/></w:style>` +
  `<w:style w:type="table" w:styleId="TabA"><w:name w:val="Lưới A"/></w:style>`

const STYLES_V2 =
  `<w:style w:type="paragraph" w:default="1" w:styleId="BodyB"><w:name w:val="Normal"/></w:style>` +
  `<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>` +
  `<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>` +
  `<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/></w:style>` +
  `<w:style w:type="paragraph" w:styleId="FootnoteText"><w:name w:val="footnote text"/></w:style>` +
  `<w:style w:type="character" w:styleId="FootnoteReference"><w:name w:val="footnote reference"/></w:style>` +
  `<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/></w:style>` +
  `<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/></w:style>`

const NUMBERING_V1 =
  `<w:abstractNum w:abstractNumId="3"><w:multiLevelType w:val="hybridMultilevel"/>` +
  `<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/></w:lvl></w:abstractNum>` +
  `<w:num w:numId="7"><w:abstractNumId w:val="3"/></w:num>`

const FOOTNOTES_V1 = part(
  `<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>` +
    `<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>` +
    `<w:footnote w:id="2"><w:p><w:pPr><w:pStyle w:val="Ghichu"/></w:pPr><w:r><w:rPr><w:rStyle w:val="KyTu"/></w:rPr><w:footnoteRef/></w:r><w:r><w:t>Footnote text v1</w:t></w:r></w:p></w:footnote>`,
  "footnotes"
)

const tcell = (text: string, width: number) => `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/></w:tcPr>${p(text)}</w:tc>`
const trow = (cells: string[], width: number) => `<w:tr>${cells.map((c) => tcell(c, width)).join("")}</w:tr>`
const tbl = (rows: string[][], width: number, style: string) => {
  const col = Math.round(width / rows[0].length)
  return (
    `<w:tbl><w:tblPr><w:tblStyle w:val="${style}"/><w:tblW w:w="${width}" w:type="dxa"/></w:tblPr>` +
    `<w:tblGrid>${rows[0].map(() => `<w:gridCol w:w="${col}"/>`).join("")}</w:tblGrid>${rows.map((r) => trow(r, col)).join("")}</w:tbl>`
  )
}

const drawing =
  `<w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="100" cy="100"/><wp:docPr id="5" name="Pic"/>` +
  `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
  `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:blipFill><a:blip r:embed="rId10"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`

const sect = (margin: number) => `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="${margin}" w:bottom="1440" w:left="${margin}"/></w:sectPr>`
const h1 = (text: string, style: string) => `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`

export interface SourceOptions {
  /** Thêm OLE + link UNC + ảnh ngoài vào mục Introduction (file nền "bẩn"). */
  dangerous?: boolean
  /** Thêm field INCLUDETEXT vào mục Overview — mục này chép lỗi. */
  unsafeOverview?: boolean
  /** Overview: ảnh thứ hai + bảng + field INCLUDETEXT sau bảng — chép nhiều đoạn, đoạn cuối lỗi (mục dựng từ Spine, ảnh đã chép phải được dọn). */
  overviewTrap?: boolean
}

/** File nền v1: Introduction (chữ, danh sách, ảnh, footnote), Overview (bảng 2 cột), Extra Notes (mục riêng), Record of Changes, Edited. */
export const buildV1Source = (opts: SourceOptions = {}): Promise<Buffer> =>
  makeDocx({
    styles: STYLES_V1,
    sectPr: sect(1440),
    body:
      h1("1 Introduction", "u1") +
      p("Purpose paragraph v1") +
      `<w:p><w:pPr><w:pStyle w:val="Dsach"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="7"/></w:numPr></w:pPr><w:r><w:t>List item alpha</w:t></w:r></w:p>` +
      `<w:p><w:pPr><w:pStyle w:val="Dsach"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="7"/></w:numPr></w:pPr><w:r><w:t>List item beta</w:t></w:r></w:p>` +
      `<w:p>${drawing}</w:p>` +
      `<w:p><w:r><w:t>Text with note</w:t></w:r><w:r><w:rPr><w:rStyle w:val="KyTu"/></w:rPr><w:footnoteReference w:id="2"/></w:r></w:p>` +
      (opts.dangerous
        ? `<w:p><w:r><w:object><o:OLEObject xmlns:o="urn:schemas-microsoft-com:office:office" r:id="rId15"/></w:object></w:r></w:p>` +
          `<w:p><w:hyperlink r:id="rId12"><w:r><w:t>unc link text</w:t></w:r></w:hyperlink></w:p>`
        : "") +
      h1("2 Overview", "u1") +
      p("Overview text v1") +
      (opts.unsafeOverview ? `<w:p><w:fldSimple w:instr=" INCLUDETEXT &quot;c:\\secret.docx&quot; "><w:r><w:t>x</w:t></w:r></w:fldSimple></w:p>` : "") +
      (opts.overviewTrap ? `<w:p>${drawing.replace("rId10", "rId11")}</w:p>` : "") +
      tbl([["Feature", "Priority"], ["Feature X", "High"], ["Feature Y", "Low"]], 9000, "TabA") +
      (opts.overviewTrap ? `<w:p><w:fldSimple w:instr=" INCLUDETEXT &quot;c:\\secret.docx&quot; "><w:r><w:t>x</w:t></w:r></w:fldSimple></w:p>` : "") +
      h1("3 Extra Notes", "u1") +
      p("Extra note text v1") +
      h1("Record of Changes", "u1") +
      tbl([["Version", "Date", "Description"], ["1.0", "2026-01-01", "Initial"], ["1.1", "2026-02-01", "Second"]], 9000, "TabA") +
      h1("4 Edited", "u1") +
      p("Old text of edited"),
    extraDocRels:
      rel("rId10", "image", "media/image1.png") +
      rel("rId11", "image", "media/image2.png") +
      rel("rId12", "hyperlink", String.raw`\\fileserver\share\doc.docx`, true) +
      rel("rId13", "footnotes", "footnotes.xml") +
      rel("rId14", "numbering", "numbering.xml") +
      (opts.dangerous ? rel("rId15", "oleObject", "embeddings/oleObject1.bin") : ""),
    extraParts: {
      "word/media/image1.png": makePng(4, 4),
      "word/media/image2.png": makePng(6, 6),
      "word/numbering.xml": part(NUMBERING_V1, "numbering"),
      "word/footnotes.xml": FOOTNOTES_V1,
      ...(opts.dangerous ? { "word/embeddings/oleObject1.bin": "OLE-BYTES" } : {})
    },
    extraContentTypes:
      `<Default Extension="png" ContentType="image/png"/><Default Extension="bin" ContentType="application/vnd.openxmlformats-officedocument.oleObject"/>` +
      `<Override PartName="/word/numbering.xml" ContentType="${CT}.numbering+xml"/><Override PartName="/word/footnotes.xml" ContentType="${CT}.footnotes+xml"/>`
  })

/** Mẫu v2: heading đánh lại, thêm mục New, bảng Overview thêm cột Owner, Record of Changes thêm cột Author, lề hẹp hơn, settings có attachedTemplate UNC. */
export const buildV2Template = (opts: { orphanNumId?: boolean } = {}): Promise<Buffer> =>
  makeDocx({
    styles: STYLES_V2,
    sectPr: sect(2000),
    body:
      h1("1. Introduction", "Heading1") +
      p("Guidance intro: describe the purpose") +
      h1("2. Overview", "Heading1") +
      p("Guidance overview: list features") +
      tbl([["Feature", "Priority", "Owner"], ["Sample feature", "Sample", "Sample"]], 7900, "TableGrid") +
      h1("3. Edited", "Heading1") +
      (opts.orphanNumId ? p("Guidance edited: write here", `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="99"/></w:numPr>`) : p("Guidance edited: write here")) +
      h1("4. Brand New", "Heading1") +
      p("Guidance new: describe the new section") +
      h1("Record of Changes", "Heading1") +
      tbl([["Version", "Date", "Author", "Description"], ["x", "x", "x", "x"]], 7900, "TableGrid"),
    extraDocRels: rel("rId30", "settings", "settings.xml"),
    extraParts: {
      "word/settings.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="${NS.w}" xmlns:r="${NS.r}"><w:zoom w:percent="100"/><w:attachedTemplate r:id="rId1"/><w:compat/></w:settings>`,
      "word/_rels/settings.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${NS.rels}">${rel("rId1", "attachedTemplate", String.raw`\\fileserver\templates\corp.dotm`, true)}</Relationships>`
    },
    extraContentTypes: `<Override PartName="/word/settings.xml" ContentType="${CT}.settings+xml"/>`
  })

// ─── mô tả ghép mục / nhóm của hai fixture ───────────────────────

export const V1_HEADINGS: OldHeading[] = [
  { key: "fixed:1.1", heading_text: "1 Introduction", level: 1, section_id: "fixed:1.1" },
  { key: "fixed:2.1", heading_text: "2 Overview", level: 1, section_id: "fixed:2.1" },
  { key: "custom:x", heading_text: "3 Extra Notes", level: 1, section_id: "custom:x" },
  { key: "fixed:I", heading_text: "Record of Changes", level: 1, section_id: "fixed:I" },
  { key: "fixed:4.1", heading_text: "4 Edited", level: 1, section_id: "fixed:4.1" }
]
/** Thứ tự heading trong file v1. */
export const V1_HEADING_KEYS = V1_HEADINGS.map((h) => h.key)

export const V2_HEADINGS: NewHeading[] = [
  { key: "n0", heading_text: "1. Introduction", section_id: "fixed:1.1" },
  { key: "n1", heading_text: "2. Overview", section_id: "fixed:2.1" },
  { key: "n2", heading_text: "3. Edited", section_id: "fixed:4.1" },
  { key: "n3", heading_text: "4. Brand New", section_id: "fixed:9.9", guidance: "Guidance new" },
  { key: "n4", heading_text: "Record of Changes", section_id: "fixed:I" }
]

const pair = (old_key: string, new_key: string | null) => ({ old_key, new_key, by: new_key ? ("section_id" as const) : null, score: 1, needs_review: false })

export const emptyGroups = (): MigrationGroups => ({ matched: [], missing: [], extra: [], conflict: [], edited_since: [], structure_only_dropped: [], restored_from_snapshot: null })

/** v1 → v2: Extra Notes không có chỗ (extra), Record of Changes đổi cột (conflict), Brand New thiếu. */
export const forwardPlan = (): { pairing: PairingResult; groups: MigrationGroups } => ({
  pairing: {
    pairs: [pair("fixed:1.1", "n0"), pair("fixed:2.1", "n1"), pair("custom:x", null), pair("fixed:I", "n4"), pair("fixed:4.1", "n2")],
    followers: [],
    ignored_new: [],
    split: []
  },
  groups: {
    ...emptyGroups(),
    matched: [
      { id: "m:fixed:1.1", old_key: "fixed:1.1", new_key: "n0", by: "section_id", needs_review: false },
      { id: "m:fixed:2.1", old_key: "fixed:2.1", new_key: "n1", by: "section_id", needs_review: false },
      { id: "m:fixed:4.1", old_key: "fixed:4.1", new_key: "n2", by: "section_id", needs_review: false }
    ],
    missing: [{ id: "x:n3", new_key: "n3", heading_text: "4. Brand New", section_id: "fixed:9.9", needs_content: true, guidance: "Guidance new" }],
    extra: [{ id: "e:custom:x", old_key: "custom:x", heading_text: "3 Extra Notes", section_id: "custom:x", follower_keys: [], choices: ["keep_custom", "delete"], ai_choices: [], decision_required: true }],
    conflict: [
      { id: "c:record_of_changes:fixed:I", kind: "record_of_changes", old_key: "fixed:I", new_key: "n4", candidate_keys: [], old_columns: [["roc:version", "roc:date", "roc:description"]], new_columns: [["roc:version", "roc:date", "roc:in_charge", "roc:description"]], choices: ["map_by_header", "keep_old_table", "ai_resolve"], ai_choices: ["ai_resolve"], decision_required: true }
    ]
  }
})

export const FORWARD_DECISIONS = [
  { id: "e:custom:x", choice: "keep_custom" },
  { id: "c:record_of_changes:fixed:I", choice: "map_by_header" }
]
