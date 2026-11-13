/**
 * FLF-412 — "Bỏ chữ" theo từng mục ở màn đọc khung (business-flow §3.1.2).
 *
 * File tải lên thường là mẫu lấy từ dự án khác mà chưa xoá chữ cũ; Code không phân biệt được chữ bỏ quên với chữ thật nên người
 * dùng chọn theo **vùng heading**: một vùng bắt đầu ở một heading khung (mục của mẫu chuẩn, nhóm, mục BA tự đặt) và chứa mọi
 * khối tới heading khung kế tiếp — heading phần tử (UC, tính năng, chức năng, màn) cùng thân của chúng thuộc vùng đang mở.
 *
 * Vùng bỏ chữ chỉ còn khung: heading của vùng, chữ hướng dẫn thật, hàng tiêu đề bảng. Mọi chữ khác, ảnh, dòng bảng và heading
 * phần tử bị bỏ. Lúc bấm Bắt đầu, file được **viết lại** đúng như vậy rồi tách lại (`import.service`), nên các bước sau
 * (đọc nội dung, soạn, in, ngữ cảnh mẫu cho AI) chỉ thấy một file sạch — không bước nào phải biết lựa chọn này.
 */
import { isInstructionText, isRealText, tableBodyHasRealText } from "../../shared/utils/instruction-text.js"
import type { DocxPackage } from "../docx-ooxml/index.js"
import { NS } from "../docx-ooxml/xml.js"
import { pruneUnreferencedParts, requestFieldUpdate } from "../template-migration/ooxml-transplant.js"
import type { TemplateIntent } from "./target-structure.js"
import { classifySection } from "./template-skeleton.js"
import type { HeadingMapEntry } from "./template-profile.model.js"

/** Khối tối thiểu cần để chia vùng (DocBlock đã lưu hoặc ParsedBlock vừa tách). */
export interface DropBlock {
  block_id: string
  kind: string
  level?: number | null
  text: string
  rows?: string[][] | null
  image_ref?: string | null
}

type HeadingEntry = Pick<HeadingMapEntry, "block_id" | "section_id" | "heading_text" | "template_section">

export interface TextRegion {
  /** `block_id` của heading mở vùng — khoá lựa chọn, giữ nguyên qua lần tách lại (bookmark neo). */
  key: string
  title: string
  level: number
  section_id: string
  /** Vùng mở bằng mục BA tự đặt (không thuộc mẫu chuẩn). */
  custom: boolean
  /** Khối thân của vùng theo thứ tự file (kể cả heading phần tử bên trong). */
  block_ids: string[]
  /** Vùng có chữ thật (đoạn / bảng / ảnh / heading phần tử) — chỉ vùng này có lựa chọn Giữ / Bỏ chữ. */
  has_text: boolean
}

/** Khối thân mang nội dung thật của khách (chữ hướng dẫn, ô chỗ trống không tính). */
const isRealBlock = (b: DropBlock): boolean => {
  switch (b.kind) {
    case "table":
      // Bảng một hàng là khung (hàng tiêu đề, như mẫu khung tự lưu) — không tính là chữ
      return (b.rows?.length ?? 0) > 1 && tableBodyHasRealText(b.rows)
    case "image":
      return true
    case "paragraph":
    case "list_item":
    case "caption":
      return isRealText(b.text)
    default:
      return false
  }
}

/**
 * Hàm thuần: chia khối theo vùng heading khung. Khối trước heading đầu tiên (trang bìa) và ô bảng (`table_cell`, đã nằm trong
 * khối bảng) không thuộc vùng nào.
 */
export const textRegions = (blocks: readonly DropBlock[], headingMap: readonly HeadingEntry[]): TextRegion[] => {
  const byBlock = new Map(headingMap.map((h) => [h.block_id, h]))
  const regions: TextRegion[] = []
  let open: TextRegion | null = null
  for (const b of blocks) {
    if (b.kind === "table_cell") continue
    const entry = b.kind === "heading" ? byBlock.get(b.block_id) : undefined
    if (b.kind === "heading" && (!entry || classifySection(entry) !== "element")) {
      const sectionId = entry?.section_id ?? "unmapped"
      open = {
        key: b.block_id,
        title: (entry?.heading_text ?? b.text).trim(),
        level: b.level ?? 1,
        section_id: sectionId,
        custom: !entry || classifySection(entry) === "custom",
        block_ids: [],
        has_text: false
      }
      regions.push(open)
      continue
    }
    if (!open) continue
    open.block_ids.push(b.block_id)
    // Heading phần tử bên trong (UC, chức năng…) là dữ liệu của dự án cũ ⇒ vùng có chữ
    if (b.kind === "heading" || isRealBlock(b)) open.has_text = true
  }
  return regions
}

export interface DropPlan {
  /** Khối bị bỏ hẳn (kể cả heading của vùng khi bỏ cả vùng). */
  remove: Set<string>
  /**
   * Bảng chỉ giữ hàng tiêu đề + một hàng trống — đúng dạng bảng của khung mẫu trống, nên mọi bước sau (bản sơ bộ, kế hoạch
   * step) coi mục là còn trống như với khung mẫu.
   */
  blankBody: Set<string>
}

/**
 * Mục BA tự đặt ở dự án theo mẫu chuẩn FlintFlow (`free`) không có trong cấu trúc đích nên không được soạn lại ⇒ bỏ chữ là bỏ
 * cả heading, không để lại một heading trống trong bản in.
 */
const dropsHeading = (region: TextRegion, intent: TemplateIntent): boolean => region.custom && intent === "free"

/** Hàm thuần: khối bỏ / bảng chỉ còn hàng tiêu đề + hàng trống cho các vùng `keys`. Vùng không có chữ không đổi gì. */
export const planDrop = (blocks: readonly DropBlock[], regions: readonly TextRegion[], keys: ReadonlySet<string>, intent: TemplateIntent): DropPlan => {
  const byId = new Map(blocks.map((b) => [b.block_id, b]))
  const remove = new Set<string>()
  const blankBody = new Set<string>()
  for (const region of regions) {
    if (!keys.has(region.key) || !region.has_text) continue
    if (dropsHeading(region, intent)) remove.add(region.key)
    // Sau heading phần tử đầu tiên, mọi khối đều thuộc phần tử của dự án cũ ⇒ bỏ hết, kể cả chữ hướng dẫn
    let inElement = false
    for (const id of region.block_ids) {
      const b = byId.get(id)
      if (!b) continue
      if (b.kind === "heading") inElement = true
      const keep =
        !inElement &&
        !dropsHeading(region, intent) &&
        (b.kind === "table" || ((b.kind === "paragraph" || b.kind === "list_item") && isInstructionText(b.text)))
      if (!keep) remove.add(id)
      else if (b.kind === "table" && (b.rows?.length ?? 0) > 1) blankBody.add(id)
    }
  }
  return { remove, blankBody }
}

/** Hàm thuần: khối sau khi bỏ chữ — tính bản sơ bộ / ước tính credit trước khi viết lại file. */
export const applyDropToBlocks = <B extends DropBlock>(blocks: readonly B[], plan: DropPlan): B[] =>
  blocks
    .filter((b) => !plan.remove.has(b.block_id))
    .map((b) => (plan.blankBody.has(b.block_id) && b.rows ? { ...b, rows: [b.rows[0], b.rows[0].map(() => "")] } : b))

/** Lựa chọn hợp lệ: chỉ giữ khoá của vùng có chữ. */
export const validDropKeys = (regions: readonly TextRegion[], keys: Iterable<string>): string[] => {
  const allowed = new Set(regions.filter((r) => r.has_text).map((r) => r.key))
  return [...new Set(keys)].filter((k) => allowed.has(k))
}


// ─── DOM ─────────────────────────────────────────────────────────

const W = NS.w

const kids = (el: Element, local: string): Element[] =>
  Array.from(el.childNodes).filter((n): n is Element => n.nodeType === 1 && (n as Element).namespaceURI === W && (n as Element).localName === local)

const descendantsW = (el: Element, local: string): Element[] => Array.from(el.getElementsByTagNameNS(W, local))

/** Đoạn mang ngắt section (`w:pPr/w:sectPr`) giữ khổ giấy / header của phần sau — không xoá, chỉ xoá nội dung trong đoạn. */
const carriesSection = (p: Element): boolean => kids(p, "pPr").some((pr) => kids(pr, "sectPr").length > 0)

/** Phần tử nằm trong ô bảng — đi theo bảng chứa nó, không xoá riêng (ô bảng phải còn ít nhất một đoạn). */
const insideCell = (el: Element): boolean => {
  for (let n = el.parentNode; n && n.nodeType === 1; n = n.parentNode) if ((n as Element).namespaceURI === W && (n as Element).localName === "tc") return true
  return false
}

const PICTURE_TAGS = ["drawing", "pict", "object"] as const

/** Giữ `pPr` + bookmark (neo khối), bỏ mọi run / link / field còn lại của đoạn. */
const clearParagraph = (p: Element): void => {
  for (const n of Array.from(p.childNodes)) {
    const local = (n as Element).localName
    if (local !== "pPr" && local !== "bookmarkStart" && local !== "bookmarkEnd") p.removeChild(n)
  }
}

/** Đoạn chỉ còn `text` (giữ định dạng run đầu tiên) — heading gõ chung đoạn với nội dung cũ chỉ giữ phần heading. */
const setParagraphText = (p: Element, text: string): void => {
  const rPr = descendantsW(p, "rPr").find((r) => (r.parentNode as Element | null)?.localName === "r")?.cloneNode(true) ?? null
  clearParagraph(p)
  const doc = p.ownerDocument!
  const run = doc.createElementNS(W, "w:r")
  if (rPr) run.appendChild(rPr)
  const t = doc.createElementNS(W, "w:t")
  t.setAttribute("xml:space", "preserve")
  t.appendChild(doc.createTextNode(text))
  run.appendChild(t)
  p.appendChild(run)
}

const blankRowCells = (tbl: Element): void => {
  const [, blank, ...rest] = kids(tbl, "tr")
  for (const tr of rest) tbl.removeChild(tr)
  // Hàng trống giữ ô + định dạng đoạn, bỏ mọi chữ / ảnh / bảng lồng trong ô
  for (const tc of blank ? kids(blank, "tc") : []) {
    for (const nested of kids(tc, "tbl")) tc.removeChild(nested)
    for (const para of kids(tc, "p")) clearParagraph(para)
    if (!kids(tc, "p").length) tc.appendChild(tc.ownerDocument!.createElementNS(W, "w:p"))
  }
}

/**
 * Áp kế hoạch vào DOM của file (khối vừa tách từ chính file đó, có `element`). Parser cho nhiều khối dùng chung một đoạn
 * (heading gõ chung đoạn với nội dung, đoạn có chữ + ảnh) ⇒ xử lý **theo phần tử**: chỉ xoá cả đoạn khi mọi khối trên nó bị bỏ;
 * còn khối được giữ thì chỉ bỏ phần ảnh / phần chữ sau heading. Phần tử trong ô bảng đi theo bảng chứa nó.
 */
export const applyDropToDom = (blocks: readonly (DropBlock & { element: Element })[], plan: DropPlan): void => {
  const byElement = new Map<Element, (DropBlock & { element: Element })[]>()
  for (const b of blocks) {
    if (b.kind === "table_cell") continue
    byElement.set(b.element, [...(byElement.get(b.element) ?? []), b])
  }
  for (const [el, group] of byElement) {
    if (!el.parentNode || insideCell(el)) continue
    if (el.localName === "tbl") {
      if (group.some((b) => plan.remove.has(b.block_id))) el.parentNode.removeChild(el)
      else if (group.some((b) => plan.blankBody.has(b.block_id))) blankRowCells(el)
      continue
    }
    const removed = group.filter((b) => plan.remove.has(b.block_id))
    if (!removed.length) continue
    const kept = group.filter((b) => !plan.remove.has(b.block_id))
    if (!kept.length) {
      if (el.localName === "p" && carriesSection(el)) clearParagraph(el)
      else el.parentNode.removeChild(el)
      continue
    }
    // Đoạn còn khối được giữ: heading gõ chung đoạn ⇒ chỉ còn chữ heading; chữ hướng dẫn kèm ảnh cũ ⇒ bỏ ảnh
    const heading = kept.find((b) => b.kind === "heading")
    if (heading && removed.some((b) => b.kind !== "image")) setParagraphText(el, heading.text)
    else if (removed.some((b) => b.kind === "image")) for (const t of PICTURE_TAGS) for (const pic of descendantsW(el, t)) pic.parentNode?.removeChild(pic)
  }
}

const MAIN = "word/document.xml"
const MAIN_RELS = "word/_rels/document.xml.rels"
const IMAGE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"

/** Giá trị mọi thuộc tính `r:*` (id quan hệ) trong cây. */
const relIdsUsed = (root: Element): Set<string> => {
  const used = new Set<string>()
  for (const el of Array.from(root.getElementsByTagName("*"))) for (const a of Array.from(el.attributes)) if (a.namespaceURI === NS.r) used.add(a.value)
  return used
}

/** Bỏ ghi chú (`comment` / `footnote` / `endnote`) mà thân tài liệu không còn tham chiếu — chữ của đoạn cũ đã xoá. */
const pruneNotes = async (pkg: DocxPackage, body: Element): Promise<void> => {
  const parts = [
    { part: "word/comments.xml", item: "comment", ref: "commentReference" },
    { part: "word/footnotes.xml", item: "footnote", ref: "footnoteReference" },
    { part: "word/endnotes.xml", item: "endnote", ref: "endnoteReference" }
  ]
  for (const { part, item, ref } of parts) {
    const doc = await pkg.xml(part)
    if (!doc) continue
    const referenced = new Set(descendantsW(body, ref).map((r) => r.getAttributeNS(W, "id") ?? r.getAttribute("w:id")))
    for (const note of descendantsW(doc.documentElement, item)) {
      // Ghi chú đặc biệt (dấu phân cách footnote) có `w:type`, luôn giữ
      if (note.getAttributeNS(W, "type") ?? note.getAttribute("w:type")) continue
      if (!referenced.has(note.getAttributeNS(W, "id") ?? note.getAttribute("w:id"))) note.parentNode?.removeChild(note)
    }
  }
}

/**
 * Dọn gói sau khi bỏ chữ: quan hệ ảnh không còn đoạn nào dùng (kèm file ảnh trong `word/media`), ghi chú mồ côi, phần không còn
 * tới được; mục lục đánh dấu cập nhật để không giữ tên mục / UC cũ khi mở bằng Word.
 */
export const cleanupDroppedPackage = async (pkg: DocxPackage): Promise<void> => {
  const main = await pkg.requireXml(MAIN)
  const used = relIdsUsed(main.documentElement)
  const rels = await pkg.xml(MAIN_RELS)
  for (const rel of rels ? Array.from(rels.getElementsByTagNameNS(NS.rels, "Relationship")) : []) {
    if (rel.getAttribute("Type") === IMAGE_REL && !used.has(rel.getAttribute("Id") ?? "")) rel.parentNode?.removeChild(rel)
  }
  await pruneNotes(pkg, main.documentElement)
  await pruneUnreferencedParts(pkg)
  await requestFieldUpdate(pkg)
}
