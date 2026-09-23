import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  ImportedXmlComponent,
  LevelFormat,
  Packer,
  PageBreak,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableOfContents,
  TableRow,
  TextRun,
  WidthType
} from "docx"
import { imageSize } from "image-size"
import { ApiError } from "../../shared/utils/api-error.js"
import type {
  Block,
  FlagRow,
  InlineRun,
  RenderedDocument,
  RenderedSection,
  TableCell as CellRuns
} from "./rendered-document.types.js"

/** A4, lề 1 inch: vùng chữ rộng 6,27 inch ≈ 602 px ở 96 DPI (đơn vị `transformation` của docx). */
const PAGE_CONTENT_WIDTH_PX = 602
/** Cùng vùng chữ tính bằng twip: 11906 − 2 × 1440. */
const PAGE_CONTENT_WIDTH_TWIP = 9026
/** Đệm quanh bảng và ảnh, tách chúng khỏi tiêu đề/đoạn ngay trước (twip; 20 twip = 1pt). */
const BLOCK_SPACE_BEFORE = 120
const STALE_FILL = "FFF2CC"
const HEADER_FILL = "D9D9D9"
const NUMBERING_REF = "ff-numbered"
const FONT = "Times New Roman"
const CODE_FONT = "Consolas"

const HEADING_LEVELS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6
] as const

const CELL_BORDER = { style: BorderStyle.SINGLE, size: 4, color: "808080" }

/**
 * Khoảng cách chữ tới khung ô (twip: 1/1440 inch). Mặc định của Word là 0 trên/dưới và 108 hai bên, nên
 * bảng in ra bị chữ dán sát đường kẻ, nhất là ô nhiều dòng. 80 trên/dưới (~1.4 mm) và 120 hai bên
 * (~2.1 mm) cho bảng dễ đọc mà không làm cột phình.
 */
const CELL_MARGINS = { top: 80, bottom: 80, left: 120, right: 120 }

/** Chừa thêm một nhịp dưới mỗi đoạn trong ô — dòng cuối không chạm mép dưới. */
const CELL_PARAGRAPH_SPACING = { after: 20 }
const TABLE_BORDERS = {
  top: CELL_BORDER,
  bottom: CELL_BORDER,
  left: CELL_BORDER,
  right: CELL_BORDER,
  insideHorizontal: CELL_BORDER,
  insideVertical: CELL_BORDER
}

type Shading = { type: typeof ShadingType.CLEAR; color: string; fill: string } | undefined
type BodyChild = Paragraph | Table | TableOfContents

interface WriteContext {
  /** Mỗi numbered list một instance để đánh số lại từ 1. */
  nextNumberingInstance: number
}

export async function writeDocx(doc: RenderedDocument): Promise<Buffer> {
  const ctx: WriteContext = { nextNumberingInstance: 1 }
  const isDraft = doc.source === "draft" || doc.watermark === "DRAFT"

  const children: BodyChild[] = [
    ...coverPage(doc, isDraft),
    new Paragraph({ children: [new PageBreak()] }),
    new Paragraph({ text: "Table of Contents", heading: HeadingLevel.TITLE }),
    new TableOfContents("Table of Contents", { hyperlink: true, headingStyleRange: "1-3" }),
    new Paragraph({ children: [new PageBreak()] }),
    ...recordOfChanges(doc),
    ...flagsAppendix(doc, isDraft),
    new Paragraph({ children: [new PageBreak()] })
  ]

  for (const section of doc.sections) {
    children.push(...renderSection(section, ctx))
  }

  const document = new Document({
    title: `${doc.projectName} - Software Requirement Specification`,
    subject: `flintflow_version:${doc.version}`,
    creator: "FlintFlow",
    description: `${isDraft ? "Working Draft" : "Baseline"} ${doc.version} generated ${doc.generatedAt}`,
    keywords: "SRS",
    customProperties: [
      { name: "flintflow_project_id", value: doc.projectId },
      { name: "flintflow_version", value: doc.version },
      { name: "flintflow_source", value: doc.source }
    ],
    features: { updateFields: true },
    styles: {
      default: {
        document: { run: { font: FONT, size: 24 } },
        heading1: { run: { font: FONT, size: 32, bold: true } },
        heading2: { run: { font: FONT, size: 28, bold: true } },
        heading3: { run: { font: FONT, size: 26, bold: true } }
      }
    },
    numbering: {
      config: [
        {
          reference: NUMBERING_REF,
          levels: [
            {
              level: 0,
              format: LevelFormat.DECIMAL,
              text: "%1.",
              alignment: AlignmentType.START,
              style: { paragraph: { indent: { left: 720, hanging: 360 } } }
            }
          ]
        }
      ]
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: 11906, height: 16838 },
            margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 }
          }
        },
        headers: { default: pageHeader(doc, isDraft) },
        footers: { default: pageFooter() },
        children
      }
    ]
  })

  return Packer.toBuffer(document)
}

/** `<project>-<version>[-draft].docx`, chỉ ASCII an toàn cho mọi hệ điều hành. */
export function buildDocxFileName(doc: Pick<RenderedDocument, "projectName" | "version" | "source">): string {
  const project = toSlug(doc.projectName) || "srs"
  const version = doc.version.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "v0"
  const suffix = doc.source === "draft" && !version.toLowerCase().endsWith("-draft") ? "-draft" : ""
  return `${project}-${version}${suffix}.docx`
}

function toSlug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[đĐ]/g, "d")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
}

function coverPage(doc: RenderedDocument, isDraft: boolean): Paragraph[] {
  const centered = (text: string, size: number, bold = false) =>
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 240 },
      children: [new TextRun({ text, size, bold })]
    })

  return [
    new Paragraph({ spacing: { before: 3600 } }),
    centered(doc.projectName, 48, true),
    centered("Software Requirement Specification", 36, true),
    centered(`Version: ${doc.version}`, 28),
    centered(`Date: ${doc.generatedAt.slice(0, 10)}`, 28),
    centered(isDraft ? "WORKING DRAFT - NOT BASELINED" : "BASELINE", 28, true)
  ]
}

function pageHeader(doc: RenderedDocument, isDraft: boolean): Header {
  const children: Paragraph[] = [
    new Paragraph({
      alignment: AlignmentType.RIGHT,
      children: [new TextRun({ text: `${doc.projectName} - SRS ${doc.version}`, size: 18, color: "808080" })]
    })
  ]
  if (isDraft) children.push(watermarkParagraph("DRAFT"))
  return new Header({ children })
}

function pageFooter(): Footer {
  return new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ children: ["Page ", PageNumber.CURRENT, " / ", PageNumber.TOTAL_PAGES], size: 18 })]
      })
    ]
  })
}

/**
 * Watermark kiểu Word (Design → Watermark): shape VML chữ nghệ thuật xoay 315° (= -45°),
 * màu bạc 50%, neo giữa lề. Nằm trong header nên lặp trên mọi trang.
 * Lib `docx` không có API watermark ⇒ chèn XML thô; header gốc của lib đã khai báo `v:`, `o:`, `w10:`.
 */
function watermarkParagraph(text: string): Paragraph {
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;")
  const xml =
    `<w:p><w:pPr><w:pStyle w:val="Header"/></w:pPr><w:r><w:rPr><w:noProof/></w:rPr><w:pict>` +
    `<v:shapetype id="_x0000_t136" coordsize="21600,21600" o:spt="136" adj="10800" path="m@7,l@8,m@5,21600l@6,21600e">` +
    `<v:formulas><v:f eqn="sum #0 0 10800"/><v:f eqn="prod #0 2 1"/><v:f eqn="sum 21600 0 @1"/><v:f eqn="sum 0 0 @2"/>` +
    `<v:f eqn="sum 21600 0 @3"/><v:f eqn="if @0 @3 0"/><v:f eqn="if @0 21600 @1"/><v:f eqn="if @0 0 @2"/>` +
    `<v:f eqn="if @0 @4 21600"/><v:f eqn="mid @5 @6"/><v:f eqn="mid @8 @5"/><v:f eqn="mid @7 @8"/>` +
    `<v:f eqn="mid @6 @7"/><v:f eqn="sum @6 0 @5"/></v:formulas>` +
    `<v:path textpathok="t" o:connecttype="custom" o:connectlocs="@9,0;@10,10800;@11,21600;@12,10800" o:connectangles="270,180,90,0"/>` +
    `<v:textpath on="t" fitshape="t"/><v:handles><v:h position="#0,bottomRight" xrange="6629,14971"/></v:handles>` +
    `<o:lock v:ext="edit" text="t" shapetype="t"/></v:shapetype>` +
    `<v:shape id="FlintFlowWatermark" o:spid="_x0000_s2049" type="#_x0000_t136" ` +
    `style="position:absolute;margin-left:0;margin-top:0;width:468pt;height:156pt;rotation:315;z-index:-251657216;` +
    `mso-position-horizontal:center;mso-position-horizontal-relative:margin;mso-position-vertical:center;mso-position-vertical-relative:margin" ` +
    `o:allowincell="f" fillcolor="silver" stroked="f"><v:fill opacity=".5"/>` +
    `<v:textpath style="font-family:&quot;${FONT}&quot;;font-size:1pt" string="${escaped}"/>` +
    `<w10:wrap anchorx="margin" anchory="margin"/></v:shape></w:pict></w:r></w:p>`

  // fromXmlString bọc phần tử trong một nút gốc không tên ⇒ lấy phần tử <w:p> thật
  const imported = ImportedXmlComponent.fromXmlString(xml) as unknown as { root: unknown[] }
  return imported.root[0] as Paragraph
}

function recordOfChanges(doc: RenderedDocument): BodyChild[] {
  const plain = (text: string): CellRuns => [{ text }]
  return [
    new Paragraph({ text: "I. Record of Changes", heading: HeadingLevel.HEADING_1 }),
    new Paragraph({
      children: [new TextRun({ text: "*A - Added, M - Modified, D - Deleted", italics: true, size: 20 })]
    }),
    tableGap(undefined),
    table(
      ["Date", "Version", "A*, M, D", "In charge", "Change Description"].map(plain),
      doc.recordOfChanges.map((row) =>
        [row.date, row.version, row.change_type, row.in_charge, row.description].map(plain)
      ),
      undefined
    )
  ]
}

function flagsAppendix(doc: RenderedDocument, isDraft: boolean): BodyChild[] {
  const appendix = doc.flagsAppendix
  if (!appendix) return []

  const plain = (text: string): CellRuns => [{ text }]
  const flagTable = (rows: FlagRow[], withReason: boolean) =>
    table(
      (withReason ? ["ID", "Rule", "Section", "Message", "Waive reason"] : ["ID", "Rule", "Section", "Message"]).map(
        plain
      ),
      rows.map((flag) =>
        (withReason
          ? [flag.id, flag.rule_id, flag.section, flag.message, flag.waive_reason ?? ""]
          : [flag.id, flag.rule_id, flag.section, flag.message]
        ).map(plain)
      ),
      undefined
    )

  const out: BodyChild[] = []
  if (isDraft) {
    out.push(
      new Paragraph({ text: "Working Draft Status", heading: HeadingLevel.HEADING_2 }),
      new Paragraph({
        children: [
          new TextRun({ text: `Open red flags: ${appendix.redOpen.length}`, bold: true }),
          new TextRun({ text: `  ·  Stale sections: ${appendix.staleCount}`, bold: true }),
          new TextRun({ text: `  ·  Waived flags: ${appendix.waived.length}`, bold: true })
        ]
      })
    )
    if (appendix.redOpen.length > 0) {
      out.push(new Paragraph({ text: "Open Red Flags", heading: HeadingLevel.HEADING_3 }), tableGap(undefined), flagTable(appendix.redOpen, false))
    }
  }
  // srs-spine §6: mọi export, kể cả bản sạch, in danh sách waive
  if (appendix.waived.length > 0) {
    out.push(new Paragraph({ text: "Waived Flags", heading: HeadingLevel.HEADING_3 }), tableGap(undefined), flagTable(appendix.waived, true))
  }
  return out
}

function renderSection(section: RenderedSection, ctx: WriteContext): BodyChild[] {
  const needsReview = section.status === "stale" || section.awaiting_reaccept === true
  const shading: Shading = needsReview ? { type: ShadingType.CLEAR, color: "auto", fill: STALE_FILL } : undefined
  const title = section.number ? `${section.number} ${section.heading}` : section.heading

  const out: BodyChild[] = [new Paragraph({ text: title, heading: headingLevel(section.level) })]

  if (needsReview) {
    const note =
      section.status === "stale"
        ? "[STALE] Source data of this section changed after it was accepted. Content below may be outdated."
        : "[AWAITING RE-ACCEPT] This section was regenerated and is waiting for the user to accept it again."
    out.push(
      new Paragraph({
        shading,
        border: { left: { style: BorderStyle.SINGLE, size: 24, color: "BF9000", space: 4 } },
        children: [new TextRun({ text: note, bold: true, italics: true, color: "7F6000" })]
      })
    )
  }

  for (const block of section.blocks) {
    out.push(...renderBlock(block, shading, ctx))
  }
  return out
}

function renderBlock(block: Block, shading: Shading, ctx: WriteContext): BodyChild[] {
  switch (block.type) {
    case "paragraph":
      return [new Paragraph({ shading, children: runs(block.runs) })]
    case "heading":
      return [new Paragraph({ shading, heading: headingLevel(block.level), text: block.text })]
    case "bullet_list":
      return block.items.map((item) => new Paragraph({ shading, bullet: { level: 0 }, children: runs(item) }))
    case "numbered_list": {
      const instance = ctx.nextNumberingInstance++
      return block.items.map(
        (item) =>
          new Paragraph({ shading, numbering: { reference: NUMBERING_REF, level: 0, instance }, children: runs(item) })
      )
    }
    case "table":
      return [tableGap(shading), table(block.header, block.rows, shading), new Paragraph({ shading })]
    case "image":
      return image(block.png, block.caption, shading)
    case "page_break":
      return [new Paragraph({ children: [new PageBreak()] })]
  }
}

function runs(items: InlineRun[]): TextRun[] {
  return items.map(
    (run) =>
      new TextRun({
        text: run.text,
        bold: run.bold,
        italics: run.italic,
        ...(run.code ? { font: CODE_FONT, shading: { type: ShadingType.CLEAR, color: "auto", fill: "F2F2F2" } } : {})
      })
  )
}

/**
 * OOXML không có "space before" cho `w:tbl`, nên đệm trên bảng là một đoạn rỗng cỡ chữ 1pt mang
 * `spacing.before` — gần như không chiếm chiều cao, chỉ tạo khoảng hở với tiêu đề phía trên.
 */
function tableGap(shading: Shading): Paragraph {
  return new Paragraph({
    shading,
    spacing: { before: BLOCK_SPACE_BEFORE, after: 0 },
    children: [new TextRun({ text: "", size: 2 })]
  })
}

function table(header: CellRuns[], rows: CellRuns[][], shading: Shading): Table {
  const columns = Math.max(header.length, ...rows.map((row) => row.length))
  const pad = (cells: CellRuns[]) => [...cells, ...Array.from({ length: columns - cells.length }, () => [])]

  const cell = (content: CellRuns, isHeader: boolean) =>
    new TableCell({
      shading: isHeader
        ? { type: ShadingType.CLEAR, color: "auto", fill: HEADER_FILL }
        : shading && { type: ShadingType.CLEAR, color: "auto", fill: shading.fill },
      margins: CELL_MARGINS,
      children: [
        new Paragraph({
          spacing: CELL_PARAGRAPH_SPACING,
          children: runs(isHeader ? content.map((run) => ({ ...run, bold: true })) : content)
        })
      ]
    })

  // Độ rộng tuyệt đối (twip) chia đều: LibreOffice hiển thị sai bảng chỉ có width % và gridCol mặc định
  const columnWidth = Math.floor(PAGE_CONTENT_WIDTH_TWIP / columns)
  return new Table({
    width: { size: columnWidth * columns, type: WidthType.DXA },
    columnWidths: Array.from({ length: columns }, () => columnWidth),
    borders: TABLE_BORDERS,
    // Word lấy lề ô mặc định của bảng khi ô không tự khai; khai cả hai để mọi trình đọc đều giãn đúng
    margins: CELL_MARGINS,
    rows: [
      new TableRow({ tableHeader: true, children: pad(header).map((content) => cell(content, true)) }),
      ...rows.map((row) => new TableRow({ children: pad(row).map((content) => cell(content, false)) }))
    ]
  })
}

function image(png: Buffer | string, caption: string | undefined, shading: Shading): Paragraph[] {
  const data = toPngBuffer(png)
  let size: { width?: number; height?: number; type?: string }
  try {
    size = imageSize(data)
  } catch {
    throw new ApiError(422, "Image block is not a valid PNG", "RENDER_IMAGE_INVALID")
  }
  // Phase 5 (T3): ảnh gốc của file upload có thể là JPEG — nhúng nguyên, không chuyển đổi
  if ((size.type !== "png" && size.type !== "jpg") || !size.width || !size.height) {
    throw new ApiError(422, "Image block is not a valid PNG/JPEG", "RENDER_IMAGE_INVALID")
  }
  const type = size.type === "jpg" ? "jpg" : "png"

  // Chỉ thu nhỏ ảnh rộng hơn vùng chữ, không phóng to ảnh nhỏ
  const scale = Math.min(1, PAGE_CONTENT_WIDTH_PX / size.width)
  const out = [
    new Paragraph({
      shading,
      alignment: AlignmentType.CENTER,
      spacing: { before: BLOCK_SPACE_BEFORE, after: caption ? 0 : BLOCK_SPACE_BEFORE },
      children: [
        new ImageRun({
          type,
          data,
          transformation: {
            width: Math.max(1, Math.round(size.width * scale)),
            height: Math.max(1, Math.round(size.height * scale))
          }
        })
      ]
    })
  ]
  if (caption) {
    out.push(
      new Paragraph({
        shading,
        alignment: AlignmentType.CENTER,
        spacing: { after: BLOCK_SPACE_BEFORE },
        children: [new TextRun({ text: caption, italics: true, size: 20 })]
      })
    )
  }
  return out
}

function toPngBuffer(png: Buffer | string): Buffer {
  if (Buffer.isBuffer(png)) return png
  const base64 = png.replace(/^data:image\/png;base64,/, "").replace(/\s+/g, "")
  return Buffer.from(base64, "base64")
}

function headingLevel(level: number) {
  return HEADING_LEVELS[Math.min(6, Math.max(1, Math.trunc(level))) - 1]
}
