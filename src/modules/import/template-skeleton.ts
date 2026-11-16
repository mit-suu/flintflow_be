/**
 * FLF-395 (D12, D13) — dựng **khung mẫu** từ bản tài liệu vừa phát hành của một dự án mẫu tự do, để lưu thành mẫu tổ chức.
 *
 * Khung = heading thuộc mẫu chuẩn theo thứ tự + cấp, hàng tiêu đề của bảng có cấu trúc, chữ hướng dẫn của mẫu (ngoặc + kiểu chữ
 * hướng dẫn). Builder là **allow-list**: dựng mới `document.xml`, chỉ chép styles / numbering / settings / theme / bảng font đã
 * lọc; không bao giờ chép nội dung của khách. Thứ gì có thể mang chữ của khách mà Code không chắc ⇒ chờ người duyệt:
 *  - mục BA tự đặt (`unmapped`, `custom:*`) — chưa duyệt thì không vào khung;
 *  - heading mẫu chuẩn nhưng chữ khác tên chuẩn ("1 Introduction to ACME") — chưa duyệt thì ghi tên chuẩn.
 * Tên dự án trong chữ giữ lại tự đổi thành chỗ trống `{Tên khách hàng}` / `{Customer name}`.
 */
import { createHash } from "node:crypto"
import { XMLSerializer } from "@xmldom/xmldom"
import JSZip from "jszip"
import { DocxPackage } from "../docx-ooxml/index.js"
import { NS, parseXml, serializeXml } from "../docx-ooxml/xml.js"
import { isInstructionText } from "../../shared/utils/instruction-text.js"
import { normalizeTitle } from "./org-mapping.js"
import { parseDocument, type ParsedBlock } from "./parse.service.js"
import { PART_BANK, partById } from "./part-bank.js"
import { autoConfirmMapping, matchProfile } from "./profile-match.service.js"
import { SECTION_CANDIDATES } from "./section-catalog.js"
import type { HeadingMapEntry, TableMapEntry } from "./template-profile.model.js"
import { splitHeadingNumber, titleSimilarity } from "./text-similarity.js"
import { recordColumnOfHeader } from "./legacy-record.js"

export type SkeletonClass = "framework" | "element" | "custom"

/** Heading phần tử (UC, tính năng, chức năng, màn) ⇒ bỏ cả nhánh; heading thuộc mẫu chuẩn ⇒ giữ; còn lại là mục BA tự đặt. */
export const classifySection = (h: Pick<HeadingMapEntry, "section_id" | "template_section">): SkeletonClass => {
  const id = h.section_id
  if (id.startsWith("feature:") || id.startsWith("function:")) return "element"
  if (id.startsWith("fixed:") || id.startsWith("group:") || id.startsWith("slot:") || h.template_section) return "framework"
  return "custom"
}

export interface SkeletonOptions {
  projectName: string
  language: "vi" | "en"
}

/** Tên dự án (trọn từ) ⇒ chỗ trống theo ngôn ngữ. Tên quá ngắn (< 2 ký tự) không thay. */
export const scrubProjectName = (text: string, opts: SkeletonOptions): string => {
  const name = opts.projectName.trim()
  if (name.length < 2) return text
  // Chỉ thay trọn từ (dự án "Lumen" không đụng "Lumens"); heading đúng tên chuẩn không qua hàm này
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "giu")
  return text.replace(re, opts.language === "vi" ? "{Tên khách hàng}" : "{Customer name}")
}

/** Gợi ý không AI cho "giữ dạng chung": có tên dự án ⇒ thay; không có ⇒ `null`. */
export const genericSuggestion = (heading: string, projectName: string, language: "vi" | "en"): string | null => {
  const out = scrubProjectName(heading, { projectName, language })
  return out === heading ? null : out
}

const STANDARD_TITLES: ReadonlySet<string> = new Set([
  ...PART_BANK.flatMap((p) => p.titles.map((t) => normalizeTitle(t.text))),
  ...SECTION_CANDIDATES.flatMap((c) => c.titles.map(normalizeTitle))
])

/** Chữ heading (bỏ số mục) đúng một tên chuẩn của ngân hàng phần / mục FPT. */
export const isStandardWording = (heading: string): boolean => STANDARD_TITLES.has(normalizeTitle(splitHeadingNumber(heading).title))

/**
 * Tên chuẩn của mục (giữ số mục gõ tay của file) — dùng khi chữ của file chưa được duyệt. Trong các tên chuẩn của mục, chọn tên
 * gần chữ của file nhất ("1 Introduction to ACME" ⇒ "1 Introduction", không phải "Product Overview").
 */
const standardTitleOf = (h: Pick<HeadingMapEntry, "heading_text" | "section_id" | "template_section">): string | null => {
  const { number, title: own } = splitHeadingNumber(h.heading_text)
  const titles = [...((h.template_section ? partById(h.template_section)?.titles.map((t) => t.text) : undefined) ?? []), ...(SECTION_CANDIDATES.find((c) => c.id === h.section_id)?.titles ?? [])]
  if (!titles.length) return null
  const title = titles.reduce((best, t) => (titleSimilarity(own, t) > titleSimilarity(own, best) ? t : best), titles[0])
  return number ? `${number} ${title}` : title
}

/** Quyết định của người duyệt (khoá = `block_id` của heading trong file nguồn). */
export type PendingDecision = { decision: "keep" } | { decision: "generic"; text: string } | { decision: "drop" }

/** Heading cần người duyệt: mục BA tự đặt (`custom`) hoặc heading mẫu chuẩn có chữ khác tên chuẩn (`wording`). */
export interface ReviewHeading {
  key: string
  heading_text: string
  level: number
  kind: "custom" | "wording"
  /** Tên chuẩn ghi vào khung khi mục `wording` chưa được duyệt. */
  standard_title: string | null
}

type PlanBlock = Pick<ParsedBlock, "block_id" | "kind" | "level" | "text">

export type PlannedItem<B> = { kind: "heading"; block: B; text: string; level: number } | { kind: "guidance"; block: B; text: string } | { kind: "table"; block: B; headers: string[] }

export interface SkeletonPlan<B> {
  items: PlannedItem<B>[]
  /** Mọi heading cần duyệt (đã hay chưa có quyết định) — FE hiện, lưu lại để mang quyết định sang bản sau. */
  review: ReviewHeading[]
  /** Khoá các heading còn chờ (chưa có quyết định). */
  waiting: string[]
}

const RECORD_OF_CHANGES = "fixed:I"

interface OpenSection {
  body: boolean
  guidance: ReadonlySet<string>
  sectionId: string
}

/**
 * Chọn phần giữ lại theo thứ tự file. Trước heading đầu tiên (trang bìa) bỏ. Nhánh của heading bị bỏ bỏ tới heading cùng cấp
 * hoặc cao hơn; mục BA tự đặt lồng trong mục chưa duyệt vẫn vào danh sách duyệt. Bảng chỉ giữ khi Code nhận ra hàng tiêu đề
 * (`tables`), hoặc bảng Record of Changes; chữ hướng dẫn chỉ giữ khi mẫu đánh dấu bằng kiểu chữ hướng dẫn.
 */
export const planSkeleton = <B extends PlanBlock>(
  blocks: readonly B[],
  headingMap: readonly HeadingMapEntry[],
  tables: ReadonlyMap<string, string[]>,
  decisions: ReadonlyMap<string, PendingDecision>,
  opts: SkeletonOptions
): SkeletonPlan<B> => {
  const byBlock = new Map(headingMap.map((h) => [h.block_id, h]))
  const items: PlannedItem<B>[] = []
  const review: ReviewHeading[] = []
  let drop: { level: number; kind: "element" | "custom" } | null = null
  let section: OpenSection | null = null

  const reviewable = (b: B, entry: HeadingMapEntry, kind: "custom" | "wording", level: number) =>
    review.push({ key: b.block_id, heading_text: entry.heading_text, level, kind, standard_title: kind === "wording" ? standardTitleOf(entry) : null })
  const include = (b: B, entry: HeadingMapEntry, text: string, level: number, body: boolean): OpenSection => {
    items.push({ kind: "heading", block: b, text, level })
    return { body, guidance: new Set(entry.guidance_by === "brackets+format" ? (entry.guidance_blocks ?? []) : []), sectionId: entry.section_id }
  }

  for (const b of blocks) {
    const entry = b.kind === "heading" ? byBlock.get(b.block_id) : undefined
    if (entry) {
      const level = b.level ?? 1
      const cls = classifySection(entry)
      if (drop && level > drop.level) {
        // Mục BA tự đặt nằm trong mục chưa duyệt / bị bỏ: vẫn cho người duyệt thấy (không trong nhánh phần tử)
        if (drop.kind === "custom" && cls === "custom") reviewable(b, entry, "custom", level)
        continue
      }
      drop = null
      section = null
      if (cls === "element") {
        drop = { level, kind: "element" }
        continue
      }
      if (cls === "framework" && isStandardWording(entry.heading_text)) {
        // Đúng tên chuẩn ⇒ không có tên khách; không thay tên dự án (dự án tên "Product" không làm hỏng "Product Overview")
        section = include(b, entry, entry.heading_text, level, true)
        continue
      }
      const kind = cls === "framework" ? "wording" : "custom"
      reviewable(b, entry, kind, level)
      const decision = decisions.get(b.block_id)
      if (decision?.decision === "keep" || decision?.decision === "generic") {
        const text = decision.decision === "generic" ? decision.text : entry.heading_text
        // Mục BA tự đặt được duyệt: chỉ heading (người duyệt chỉ thấy tên mục, không thấy bảng / chữ bên dưới)
        section = include(b, entry, text, level, kind === "wording")
        continue
      }
      const standard = kind === "wording" ? standardTitleOf(entry) : null
      if (!decision && standard) {
        section = include(b, entry, standard, level, true)
        continue
      }
      drop = { level, kind: "custom" }
      continue
    }
    if (drop || !section?.body) continue
    if (b.kind === "table") {
      const headers = tables.get(b.block_id)
      if (headers) items.push({ kind: "table", block: b, headers })
      // Bảng Record of Changes: luôn giữ hàng tiêu đề, không bao giờ giữ dòng lịch sử
      else if (section.sectionId === RECORD_OF_CHANGES) items.push({ kind: "table", block: b, headers: [] })
    } else if (section.guidance.has(b.block_id) && isInstructionText(b.text)) {
      items.push({ kind: "guidance", block: b, text: scrubProjectName(b.text, opts) })
    }
  }
  const decided = new Set(decisions.keys())
  return { items, review, waiting: review.filter((r) => !decided.has(r.key)).map((r) => r.key) }
}

/** Dấu khung: heading (cấp + chữ chuẩn hoá) + tiêu đề cột + heading còn chờ duyệt — hai dự án khác mục riêng không trùng nhau. */
export const skeletonHash = (items: readonly PlannedItem<unknown>[], waiting: readonly Pick<ReviewHeading, "level" | "heading_text">[]): string =>
  createHash("sha256")
    .update(
      [
        ...items.flatMap((i) => (i.kind === "heading" ? [`h|${i.level}|${normalizeTitle(i.text)}`] : i.kind === "table" ? [`t|${i.headers.map(normalizeTitle).join("|")}`] : [])),
        ...waiting.map((w) => `p|${w.level}|${normalizeTitle(w.heading_text)}`)
      ].join("\n")
    )
    .digest("hex")

// ─── DOM ─────────────────────────────────────────────────────────

const W = NS.w

const childrenNs = (el: Element, ns: string, local: string): Element[] =>
  Array.from(el.childNodes).filter((n): n is Element => n.nodeType === 1 && (n as Element).namespaceURI === ns && (n as Element).localName === local)

/** Chữ của các đoạn nằm trực tiếp trong ô (bỏ bảng lồng, textbox, field). */
const cellText = (tc: Element): string =>
  childrenNs(tc, W, "p")
    .map((p) =>
      childrenNs(p, W, "r")
        .filter((r) => !childrenNs(r, W, "fldChar").length && !childrenNs(r, W, "instrText").length)
        .flatMap((r) => childrenNs(r, W, "t").map((t) => t.textContent ?? ""))
        .join("")
    )
    .join(" ")
    .trim()

/** Hàng tiêu đề bảng lịch sử: không chữ số (dòng dữ liệu có ngày / số version), mọi ô có chữ đều là tên cột lịch sử. */
export const isRecordHeaderRow = (cells: readonly string[]): boolean => {
  const filled = cells.filter((c) => c.trim())
  // "A/M/D" (thêm / sửa / xoá) là tiêu đề cột loại thay đổi hay gặp mà mẫu nhận cột chưa có
  return filled.length > 0 && filled.every((c) => !/\d/.test(c) && c.length <= 40 && (recordColumnOfHeader(c) !== null || /^a\s*[/,*]?\s*m\s*[/,]?\s*d$/i.test(c.trim())))
}

const nodeXml = (n: Node): string => new XMLSerializer().serializeToString(n)

// Ký tự điều khiển làm Word không mở được file
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g
const escapeXml = (s: string): string => s.replace(CONTROL, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

/** Bỏ mọi phần tử con có thuộc tính quan hệ (`r:id`, `r:embed` — rels không được chép) và các tên cho trước. */
const strip = (root: Element, locals: ReadonlySet<string>): Element => {
  const walk = (el: Element) => {
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType !== 1) continue
      const c = child as Element
      const hasRel = Array.from(c.attributes).some((a) => a.namespaceURI === NS.r)
      if (locals.has(c.localName) || hasRel) el.removeChild(c)
      else walk(c)
    }
  }
  walk(root)
  return root
}

/** Định dạng đoạn: bỏ ngắt section (trỏ header/footer), lịch sử sửa (tên tác giả). */
const PPR_DROP = new Set(["sectPr", "pPrChange", "rPrChange", "ins", "del", "moveFrom", "moveTo"])
const paragraphXml = (source: Element | null, text: string): string => {
  const pPr = source ? childrenNs(source, W, "pPr")[0] : undefined
  const props = pPr ? nodeXml(strip(pPr.cloneNode(true) as Element, PPR_DROP)) : ""
  return `<w:p>${props}${text ? `<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>` : ""}</w:p>`
}

/** Bảng chỉ còn hàng tiêu đề: giữ định dạng bảng / cột / ô, chữ ô dựng lại; bỏ chú thích ẩn (alt text) của bảng. */
const TBL_DROP = new Set(["tblPrChange", "tcPrChange", "trPrChange", "ins", "del", "cellIns", "cellDel", "cellMerge", "moveFrom", "moveTo", "tblCaption", "tblDescription"])
const tableXml = (tbl: Element, headers: readonly string[]): string => {
  const tr = childrenNs(tbl, W, "tr")[0]
  if (!tr) return ""
  const keep = (el: Element | undefined) => (el ? nodeXml(strip(el.cloneNode(true) as Element, TBL_DROP)) : "")
  const tcs = childrenNs(tr, W, "tc")
  // Bảng Record of Changes (không có trong mapping cột): hàng đầu phải đúng là hàng tiêu đề lịch sử, không thì bỏ cả bảng
  const recordHeader = headers.length ? null : tcs.map(cellText)
  if (recordHeader && !isRecordHeaderRow(recordHeader)) return ""
  const cells = tcs.map((tc, i) => {
    const text = recordHeader ? recordHeader[i] : (headers[i] ?? "")
    return `<w:tc>${keep(childrenNs(tc, W, "tcPr")[0])}${paragraphXml(childrenNs(tc, W, "p")[0] ?? null, text)}</w:tc>`
  })
  // Đoạn trống sau bảng: hai bảng liền nhau Word gộp làm một
  return `<w:tbl>${keep(childrenNs(tbl, W, "tblPr")[0])}${keep(childrenNs(tbl, W, "tblGrid")[0])}<w:tr>${keep(childrenNs(tr, W, "trPr")[0])}${cells.join("")}</w:tr></w:tbl><w:p/>`
}

// ─── gói ─────────────────────────────────────────────────────────

const CT = {
  document: "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
  styles: "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml",
  numbering: "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml",
  settings: "application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml",
  theme: "application/vnd.openxmlformats-officedocument.theme+xml",
  fontTable: "application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml"
} as const
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

/** Part chép từ file nguồn (đã lọc) — ngoài danh sách này không part nào sang khung. */
const KEPT_PARTS: readonly { part: string; target: string; type: string; ct: string; drop: ReadonlySet<string> }[] = [
  { part: "word/styles.xml", target: "styles.xml", type: `${REL}/styles`, ct: CT.styles, drop: new Set() },
  { part: "word/numbering.xml", target: "numbering.xml", type: `${REL}/numbering`, ct: CT.numbering, drop: new Set(["numPicBullet", "lvlPicBulletId"]) },
  {
    part: "word/settings.xml",
    target: "settings.xml",
    type: `${REL}/settings`,
    ct: CT.settings,
    // Đường dẫn mẫu gắn kèm (tên máy / người), biến tài liệu, rsid, mã định danh tài liệu, trộn thư, khoá, chú thích
    drop: new Set(["attachedTemplate", "docVars", "rsids", "docId", "mailMerge", "documentProtection", "writeProtection", "footnotePr", "endnotePr", "hdrShapeDefaults", "captions"])
  },
  { part: "word/theme/theme1.xml", target: "theme/theme1.xml", type: `${REL}/theme`, ct: CT.theme, drop: new Set() },
  { part: "word/fontTable.xml", target: "fontTable.xml", type: `${REL}/fontTable`, ct: CT.fontTable, drop: new Set(["embedRegular", "embedBold", "embedItalic", "embedBoldItalic"]) }
]

/** Khai báo namespace của gốc `document.xml` nguồn (định dạng chép sang có thể dùng w14 / mc…). */
const rootNamespaces = (doc: Document): string =>
  Array.from(doc.documentElement.attributes)
    .filter((a) => (a.name.startsWith("xmlns") || a.name === "mc:Ignorable") && a.name !== "xmlns:w" && a.name !== "xmlns:r")
    .map((a) => ` ${a.name}="${escapeXml(a.value)}"`)
    .join("")

/** Khổ giấy / lề / cột của section cuối — bỏ tham chiếu header / footer. */
const finalSectPr = (doc: Document): string => {
  const body = doc.getElementsByTagNameNS(W, "body")[0]
  const sect = body ? childrenNs(body, W, "sectPr").pop() : undefined
  return sect ? nodeXml(strip(sect.cloneNode(true) as Element, new Set(["headerReference", "footerReference", "sectPrChange"]))) : ""
}

const itemXml = (i: PlannedItem<ParsedBlock>): string => (i.kind === "table" ? tableXml(i.block.element, i.headers) : paragraphXml(i.block.element, i.text))

/** Ghi file khung theo allow-list. */
export const writeSkeletonDocx = async (pkg: DocxPackage, items: readonly PlannedItem<ParsedBlock>[]): Promise<Buffer> => {
  const source = await pkg.requireXml("word/document.xml")
  const zip = new JSZip()
  const overrides: string[] = [`<Override PartName="/word/document.xml" ContentType="${CT.document}"/>`]
  const rels: string[] = []
  for (const kept of KEPT_PARTS) {
    const doc = await pkg.xml(kept.part)
    if (!doc) continue
    // Lọc trên bản sao, không đụng DOM đang cache của gói nguồn
    const copy = parseXml(serializeXml(doc), kept.part)
    strip(copy.documentElement, kept.drop)
    zip.file(kept.part, serializeXml(copy))
    overrides.push(`<Override PartName="/${kept.part}" ContentType="${kept.ct}"/>`)
    rels.push(`<Relationship Id="rIdK${rels.length + 1}" Type="${kept.type}" Target="${kept.target}"/>`)
  }
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="${NS.ct}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides.join("")}</Types>`
  )
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${NS.rels}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`)
  zip.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${NS.rels}">${rels.join("")}</Relationships>`)
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}" xmlns:r="${NS.r}"${rootNamespaces(source)}><w:body>${items.map(itemXml).join("")}${finalSectPr(source)}</w:body></w:document>`
  )
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })
}

export interface BuiltSkeleton {
  buffer: Buffer
  hash: string
  /** Khung không có heading nào — không lưu. */
  empty: boolean
  review: ReviewHeading[]
  waiting: string[]
  /** Heading của khung theo thứ tự — mapping của bản mẫu. */
  headings: { heading_text: string; section_id: string }[]
  /** Mapping cột của khung (theo tiêu đề đã giữ). */
  table_map: { block_id: string; column_index: number; header: string; field_path: string | null }[]
}

/**
 * Tiêu đề cột của bảng có cấu trúc: chỉ bảng có ít nhất một cột Code ánh xạ được vào field (`field_path`), và chỉ ghi chữ của
 * các cột đó (cột không ánh xạ để trống) — bảng khoá–giá trị ("Prepared by | <tên>"), bảng đặc tả UC ("UC ID | UC-07…") không
 * mang được chữ của khách sang khung. Tên dự án trong tiêu đề ⇒ chỗ trống.
 */
const headersByTable = (table: readonly TableMapEntry[], opts: SkeletonOptions): Map<string, string[]> => {
  const out = new Map<string, string[]>()
  for (const t of table) {
    const row = out.get(t.block_id) ?? []
    row[t.column_index] = t.field_path ? scrubProjectName(t.header, opts) : ""
    out.set(t.block_id, row)
  }
  return new Map([...out].filter(([, row]) => row.some((h) => h?.trim())).map(([id, row]) => [id, Array.from(row, (h) => h ?? "")]))
}

/** File tài liệu (bản vừa phát hành) ⇒ khớp mẫu (tất định, không AI) ⇒ khung + dấu + danh sách heading cần duyệt. */
export const buildSkeleton = async (source: Buffer, opts: SkeletonOptions, decisions: ReadonlyMap<string, PendingDecision> = new Map()): Promise<BuiltSkeleton> => {
  const { pkg, blocks } = await parseDocument(source)
  const matched = matchProfile(blocks, { fixedTemplate: false })
  autoConfirmMapping(matched)
  const plan = planSkeleton(blocks, matched.heading_map, headersByTable(matched.table_map, opts), decisions, opts)
  const byBlock = new Map(matched.heading_map.map((h) => [h.block_id, h]))
  const waiting = plan.review.filter((r) => plan.waiting.includes(r.key))
  const fieldOf = (blockId: string, column: number) => matched.table_map.find((t) => t.block_id === blockId && t.column_index === column)?.field_path ?? null
  return {
    buffer: await writeSkeletonDocx(pkg, plan.items),
    hash: skeletonHash(plan.items, waiting),
    empty: !plan.items.some((i) => i.kind === "heading"),
    review: plan.review,
    waiting: plan.waiting,
    headings: plan.items.flatMap((i) => (i.kind === "heading" ? [{ heading_text: i.text, section_id: byBlock.get(i.block.block_id)?.section_id ?? "unmapped" }] : [])),
    table_map: plan.items.flatMap((i) => (i.kind === "table" ? i.headers.map((header, column_index) => ({ block_id: i.block.block_id, column_index, header, field_path: fieldOf(i.block.block_id, column_index) })) : []))
  }
}
