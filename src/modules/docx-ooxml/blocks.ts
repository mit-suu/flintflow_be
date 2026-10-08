/**
 * Tách `word/document.xml` thành danh sách block (I-2, nút 1.5) + neo block bằng bookmark ẩn (G3).
 * FLF-171, plan §6 2A; phát hiện P0 §4.2:
 * - styleId heading bị Word bản địa hoá (`Heading1` → `u1`) ⇒ nhận heading qua `w:name` / `outlineLvl` của
 *   `styles.xml`, đi theo `basedOn`.
 * - SRS thật không dùng style heading ⇒ nhánh dự phòng theo mẫu số mục `3.2.1  Tiêu đề` (`numbering_pattern`,
 *   độ tin thấp ở I-3).
 * - Mục lục (TOC) bị loại vì trùng text với heading.
 * - Bookmark `_ff_<blockId>` có thể bị Word dời ra ngoài `w:p` (đoạn rỗng, ô bảng) ⇒ gắn cho đoạn kế tiếp.
 * - Bảng cấp 1 neo bằng `_fft_<blockId>` trong đoạn đầu của ô đầu (FLF-178) — nằm ngay trước bảng cũng nhận.
 */

import { BLOCK_BOOKMARK_PREFIX, TABLE_BOOKMARK_PREFIX, type DocBlockKind, type HeadingDetector } from "../import/import.constants.js"
import type { DocxPackage } from "./package.js"
import { paragraphText, textHash } from "./text.js"
import { NS, isW, maxWId, wAll, wAttr, wEl, wKid, wKids } from "./xml.js"

export const MAIN_PART = "word/document.xml"

export interface CellRef {
  /** Thứ tự bảng trong tài liệu (0-based, chỉ bảng cấp 1). */
  table: number
  row: number
  col: number
}

export interface OoxmlBlock {
  ordinal: number
  kind: DocBlockKind
  level: number | null
  heading_detector: HeadingDetector | null
  /** Tên style (`heading 1`, `Caption`…) — không phải styleId (bị bản địa hoá). */
  style_name: string | null
  /** Tiêu đề các heading cha (không gồm chính nó). */
  heading_path: string[]
  /** Tên bookmark neo (`_ff_B0001`) nếu đoạn đã được neo. */
  bookmark: string | null
  para_id: string | null
  xml_path: string
  text: string
  text_hash: string
  /** `false` ⇒ CR không được sửa (ảnh, textbox, field code, bảng lồng…). */
  editable: boolean
  cell: CellRef | null
  /** Chỉ với `kind = "table"`: text từng ô theo hàng. */
  rows: string[][] | null
  /**
   * Mode 1 v3 phase 5 (T3): part ảnh trong gói (`word/media/image3.png`) của đoạn có hình — từ `a:blip/@r:embed` qua rels
   * của `document.xml`. `null` nếu đoạn không có hình hoặc hình không nhúng (liên kết ngoài).
   */
  image_ref: string | null
  element: Element
  /**
   * Block tách ra từ cùng một `w:p` với block khác (FLF-252): phần chữ sau heading gõ chung đoạn ("4.2.4 Security" +
   * ngắt dòng + câu), hoặc ảnh nằm chung đoạn với chữ ("Screen layout:" + ảnh). Không neo bookmark riêng (đoạn đã mang
   * bookmark của block kia; chữ tìm lại theo `text_hash`), không cho CR sửa tại chỗ.
   */
  tail?: boolean
}

interface StyleInfo {
  name: string
  basedOn: string | null
  outlineLvl: number | null
  numbered: boolean
}

const readStyles = (styles: Document | null): Map<string, StyleInfo> => {
  const map = new Map<string, StyleInfo>()
  if (!styles) return map
  for (const s of wAll(styles, "style")) {
    const id = wAttr(s, "styleId")
    if (!id) continue
    const pPr = wKid(s, "pPr")
    const lvl = pPr ? wAttr(wKid(pPr, "outlineLvl"), "val") : null
    map.set(id, {
      name: wAttr(wKid(s, "name"), "val") ?? "",
      basedOn: wAttr(wKid(s, "basedOn"), "val"),
      outlineLvl: lvl === null ? null : Number(lvl),
      numbered: !!(pPr && wKid(pPr, "numPr"))
    })
  }
  return map
}

/** Đi theo chuỗi `basedOn` (tối đa 10 bậc, chống vòng). */
const styleChain = (styles: Map<string, StyleInfo>, id: string | null): StyleInfo[] => {
  const out: StyleInfo[] = []
  for (let k = 0, cur = id; cur && k < 10; k++) {
    const s = styles.get(cur)
    if (!s) break
    out.push(s)
    cur = s.basedOn
  }
  return out
}

const HEADING_NAME = /^heading ([1-9])$/i
const TOC_NAME = /^(toc [1-9]|table of figures|toc heading)$/i
const CAPTION_NAME = /^caption$/i
/**
 * Chú thích hình/bảng nhận theo chữ (FLF-251): SRS thật hay gõ "Figure 03 - Use Case Diagram" bằng style heading để
 * vào mục lục hình ⇒ trước đây thành heading (rác ở bước mapping, ảnh mất caption). "Table of Contents" không có số ⇒ không khớp.
 */
const CAPTION_TEXT = /^(?:figure|fig\.?|hình|table|bảng|sơ đồ|biểu đồ)\s*\d+(?:[.-]\d+)*\b/i
/** `3.2.1  Register account` — mỗi đoạn số ≤ 2 chữ số, tiêu đề không kết thúc bằng dấu câu. */
const NUMBERED_HEADING = /^((?:[1-9]\d?)(?:\.(?:\d{1,2})){0,5})\.?[ \t ]+(\S.{0,148})$/
const SENTENCE_END = /[.;:,!?]$/

const numberingPatternLevel = (text: string): number | null => {
  const m = NUMBERED_HEADING.exec(text.trim())
  if (!m || SENTENCE_END.test(m[2].trim()) || /^\d/.test(m[2])) return null
  return m[1].split(".").length
}

/** Số mục gõ tay ở đầu heading (`4.2.3`); không có ⇒ `null`. */
const typedNumber = (text: string): number[] | null => {
  const m = NUMBERED_HEADING.exec(text.trim())
  return m ? m[1].split(".").map(Number) : null
}

/** `next` là số mục kế tiếp hợp lý sau `prev`: mục con đầu (4.2.3 ⇒ 4.2.3.1) hoặc mục anh em kế ở mọi cấp (4.2.4, 4.3, 5). */
export const followsNumber = (prev: readonly number[], next: readonly number[]): boolean => {
  if (next.length === prev.length + 1 && next[next.length - 1] === 1 && prev.every((n, i) => next[i] === n)) return true
  const k = next.length
  return k >= 1 && k <= prev.length && next.slice(0, k - 1).every((n, i) => prev[i] === n) && next[k - 1] === prev[k - 1] + 1
}

/**
 * Heading gõ chung đoạn với nội dung, ngăn bằng ngắt dòng (FLF-252 — SRS thật: "4.2.4 Security" Shift+Enter "The system
 * must…", không style): dòng đầu là số mục nhiều cấp nối tiếp heading đứng trước ⇒ `{ heading, rest }`. Chỉ nhận số nối
 * tiếp để danh sách gõ tay ("1. Mở trang" ⏎ "2. Bấm nút") không thành heading.
 */
export const inlineHeading = (text: string, previousHeading: string | null): { heading: string; level: number; rest: string } | null => {
  const lines = text.split("\n")
  const first = lines.findIndex((l) => l.trim())
  if (first < 0) return null
  const heading = lines[first].trim()
  const rest = lines.slice(first + 1).join("\n").trim()
  const level = numberingPatternLevel(heading)
  const number = typedNumber(heading)
  const prev = previousHeading ? typedNumber(previousHeading) : null
  if (!rest || level === null || level < 2 || heading.length > 80 || !number || !prev || !followsNumber(prev, number)) return null
  return { heading, level, rest }
}

/** Nội dung nhúng không phải chữ của đoạn: textbox, OLE, SmartArt. */
const hasEmbeddedObject = (p: Element): boolean =>
  ["txbxContent", "object"].some((local) => wAll(p, local).length > 0) ||
  p.getElementsByTagNameNS("http://schemas.openxmlformats.org/drawingml/2006/diagram", "relIds").length > 0

/** Đoạn có field code (REF, PAGE…): sửa theo từ dễ làm hỏng field ⇒ không cho CR sửa. */
const hasField = (p: Element): boolean =>
  wAll(p, "fldChar").length > 0 || wAll(p, "instrText").length > 0 || wAll(p, "fldSimple").length > 0

/** Field mục lục `TOC \o "1-3"…` (thư viện docx không gắn docPartGallery cho content control mục lục). */
const hasTocField = (node: Element): boolean =>
  wAll(node, "instrText").some((t) => /^\s*TOC\b/.test(t.textContent ?? "")) ||
  wAll(node, "fldSimple").some((f) => /^\s*TOC\b/.test(wAttr(f, "instr") ?? ""))

const hasPicture = (p: Element): boolean => wAll(p, "drawing").length > 0 || wAll(p, "pict").length > 0

const isTocSdt = (sdt: Element): boolean => {
  const pr = wKid(sdt, "sdtPr")
  const gallery = pr ? wAll(pr, "docPartGallery")[0] : undefined
  return (!!gallery && /table of contents/i.test(wAttr(gallery, "val") ?? "")) || hasTocField(sdt)
}

const ffBookmarkOf = (node: Element): string | null => {
  for (const b of wAll(node, "bookmarkStart")) {
    const name = wAttr(b, "name")
    if (name?.startsWith(BLOCK_BOOKMARK_PREFIX)) return name
  }
  return null
}

/** Neo `_fft_` của bảng: bookmark đầu tiên mang tiền tố bảng bên trong `w:tbl`. */
const tableBookmarkOf = (tbl: Element): string | null => {
  for (const b of wAll(tbl, "bookmarkStart")) {
    const name = wAttr(b, "name")
    if (name?.startsWith(TABLE_BOOKMARK_PREFIX)) return name
  }
  return null
}

/** Đoạn đầu tiên của ô đầu tiên — nơi ghi neo của bảng. */
const firstCellParagraph = (tbl: Element): Element | null => {
  const tc = wKids(tbl, "tr").flatMap((tr) => wKids(tr, "tc"))[0]
  return (tc && wKids(tc, "p")[0]) ?? null
}

/** Tách block từ DOM (hàm thuần trên DOM, không đọc zip). */
/** Mọi `a:blip/@r:embed` của đoạn theo thứ tự ⇒ part ảnh (`word/media/…`) theo rels của `document.xml`. */
const imageRefsOf = (p: Element, imageTargets: ReadonlyMap<string, string>): string[] => {
  const out: string[] = []
  for (const blip of Array.from(p.getElementsByTagNameNS("*", "blip"))) {
    const rid = blip.getAttributeNS(NS.r, "embed")
    const target = rid ? imageTargets.get(rid) : undefined
    if (target) out.push(target.startsWith("/") ? target.slice(1) : `word/${target}`)
  }
  return out
}

/** `a:blip/@r:embed` đầu tiên của đoạn ⇒ part ảnh; không có ⇒ `null`. */
const imageRefOf = (p: Element, imageTargets: ReadonlyMap<string, string>): string | null => imageRefsOf(p, imageTargets)[0] ?? null

/** Hình đứng trước chữ đầu tiên của đoạn ("[ảnh] ⏎ Figure 3 …"); "Screen layout: [ảnh]" ⇒ chữ trước. */
const pictureBeforeText = (p: Element): boolean => {
  for (const el of Array.from(p.getElementsByTagNameNS(NS.w, "*"))) {
    if (el.localName === "drawing" || el.localName === "pict") return true
    if (el.localName === "t" && (el.textContent ?? "").trim()) return false
  }
  return false
}

export const parseBlocks = (doc: Document, stylesDoc: Document | null = null, imageTargets: ReadonlyMap<string, string> = new Map()): OoxmlBlock[] => {
  const styles = readStyles(stylesDoc)
  const body = wAll(doc, "body")[0]
  if (!body) return []
  const blocks: OoxmlBlock[] = []
  const headingStack: { level: number; text: string }[] = []
  const seenBookmarks = new Set<string>()
  let pendingBookmark: string | null = null
  let pendingTableBookmark: string | null = null
  let tableCount = 0

  const push = (b: Omit<OoxmlBlock, "ordinal" | "heading_path" | "text_hash">): OoxmlBlock => {
    const block: OoxmlBlock = { ...b, ordinal: blocks.length, heading_path: headingStack.map((h) => h.text), text_hash: textHash(b.text) }
    blocks.push(block)
    return block
  }

  const takeBookmark = (p: Element): string | null => {
    const own = ffBookmarkOf(p)
    const name = own ?? pendingBookmark
    pendingBookmark = null
    if (!name || seenBookmarks.has(name)) return null
    seenBookmarks.add(name)
    return name
  }

  const paragraph = (p: Element, path: string, cell: CellRef | null): void => {
    const pPr = wKid(p, "pPr")
    const styleId = pPr ? wAttr(wKid(pPr, "pStyle"), "val") : null
    const chain = styleChain(styles, styleId)
    const styleName = chain[0]?.name || null
    if (chain.some((s) => TOC_NAME.test(s.name)) || hasTocField(p)) return
    const text = paragraphText(p)
    const embedded = hasEmbeddedObject(p)
    const base = {
      para_id: p.getAttributeNS(NS.w14, "paraId") || null,
      xml_path: path,
      text,
      cell,
      rows: null,
      element: p,
      style_name: styleName,
      image_ref: hasPicture(p) ? imageRefOf(p, imageTargets) : null
    }

    if (!text.trim()) {
      if (!hasPicture(p) && !embedded) return
      push({ ...base, kind: hasPicture(p) && !wAll(p, "txbxContent").length ? "image" : "unsupported", level: null, heading_detector: null, bookmark: takeBookmark(p), editable: false })
      return
    }

    let kind: DocBlockKind = cell ? "table_cell" : "paragraph"
    let level: number | null = null
    let detector: HeadingDetector | null = null
    if (chain.some((s) => CAPTION_NAME.test(s.name))) kind = "caption"
    else if (!cell && CAPTION_TEXT.test(text.trim())) kind = "caption"
    else if (!cell) {
      const direct = pPr ? wAttr(wKid(pPr, "outlineLvl"), "val") : null
      if (direct !== null && Number(direct) < 9) {
        level = Number(direct) + 1
        detector = "outline_level"
      } else {
        for (const s of chain) {
          const m = HEADING_NAME.exec(s.name)
          if (m) {
            level = Number(m[1])
            detector = "style"
            break
          }
          if (s.outlineLvl !== null) {
            if (s.outlineLvl < 9) {
              level = s.outlineLvl + 1
              detector = "outline_level"
            }
            break
          }
        }
      }
      if (level === null) {
        const numbered = numberingPatternLevel(text)
        if (numbered !== null) {
          level = numbered
          detector = "numbering_pattern"
        }
      }
      if (level !== null) kind = "heading"
      else if ((pPr && wKid(pPr, "numPr")) || chain.some((s) => s.numbered)) kind = "list_item"
    }

    // Heading gõ chung đoạn với nội dung (FLF-252) ⇒ block heading + block phần chữ sau; cả hai không sửa tại chỗ được
    // (sửa một phần đoạn sẽ ghi đè phần kia)
    const split = kind === "paragraph" ? inlineHeading(text, headingStack[headingStack.length - 1]?.text ?? null) : null
    if (split) {
      while (headingStack.length && headingStack[headingStack.length - 1].level >= split.level) headingStack.pop()
      push({ ...base, text: split.heading, kind: "heading", level: split.level, heading_detector: "numbering_pattern", bookmark: takeBookmark(p), editable: false })
      headingStack.push({ level: split.level, text: split.heading })
      push({ ...base, text: split.rest, para_id: null, image_ref: null, kind: "paragraph", level: null, heading_detector: null, bookmark: null, editable: false, tail: true })
      return
    }

    // Đoạn có cả chữ lẫn hình ("Screen layout:" + ảnh màn hình, "[sơ đồ] ⏎ Figure xx - Screen flow") ⇒ block chữ + block ảnh
    // đúng thứ tự trong đoạn (FLF-252). Trước đây cả đoạn là block chữ: bản in mất ảnh, I-4 không đọc được sơ đồ.
    const pictures = !cell && kind !== "heading" && hasPicture(p) && !wAll(p, "txbxContent").length ? imageRefsOf(p, imageTargets) : []
    if (pictures.length) {
      const imagesFirst = pictureBeforeText(p)
      const textBlock = () => push({ ...base, image_ref: null, kind, level, heading_detector: detector, bookmark: takeBookmark(p), editable: !embedded && !hasField(p) })
      const imageBlocks = () =>
        pictures.forEach((ref) =>
          push({ ...base, text: "", image_ref: ref, para_id: null, kind: "image", level: null, heading_detector: null, bookmark: null, editable: false, tail: true })
        )
      if (imagesFirst) {
        // bookmark của đoạn vẫn về block chữ (block ảnh không neo riêng)
        const own = takeBookmark(p)
        imageBlocks()
        push({ ...base, image_ref: null, kind, level, heading_detector: detector, bookmark: own, editable: !embedded && !hasField(p) })
      } else {
        textBlock()
        imageBlocks()
      }
      return
    }

    const bookmark = takeBookmark(p)
    if (kind === "heading" && level !== null) {
      while (headingStack.length && headingStack[headingStack.length - 1].level >= level) headingStack.pop()
    }
    push({ ...base, kind, level, heading_detector: detector, bookmark, editable: !embedded && !hasField(p) })
    if (kind === "heading" && level !== null) headingStack.push({ level, text: text.trim() })
  }

  const table = (tbl: Element, path: string, nested: boolean): void => {
    const rowsEl = wKids(tbl, "tr")
    const rows = rowsEl.map((tr) => wKids(tr, "tc").map((tc) => wKids(tc, "p").map(paragraphText).join("\n").trim()))
    const text = rows.map((r) => r.join(" | ")).join("\n")
    if (nested) {
      push({ kind: "unsupported", level: null, heading_detector: null, style_name: null, bookmark: null, para_id: null, xml_path: path, text, editable: false, cell: null, rows, element: tbl, image_ref: null })
      return
    }
    const index = tableCount++
    const own = tableBookmarkOf(tbl) ?? pendingTableBookmark
    pendingTableBookmark = null
    const bookmark = own && !seenBookmarks.has(own) ? own : null
    if (bookmark) seenBookmarks.add(bookmark)
    push({ kind: "table", level: null, heading_detector: null, style_name: null, bookmark, para_id: null, xml_path: path, text, editable: false, cell: null, rows, element: tbl, image_ref: null })
    rowsEl.forEach((tr, ri) =>
      wKids(tr, "tc").forEach((tc, ci) => walk(tc, `${path}/tr[${ri}]/tc[${ci}]`, { table: index, row: ri, col: ci }))
    )
  }

  const walk = (container: Element, path: string, cell: CellRef | null): void => {
    const counters = new Map<string, number>()
    for (let c = container.firstChild; c; c = c.nextSibling) {
      if (!isW(c)) continue
      const idx = counters.get(c.localName) ?? 0
      counters.set(c.localName, idx + 1)
      const here = `${path}/${c.localName}[${idx}]`
      switch (c.localName) {
        case "p":
          paragraph(c, here, cell)
          break
        case "tbl":
          table(c, here, cell !== null)
          break
        case "sdt": {
          const content = wKid(c, "sdtContent")
          if (content && !isTocSdt(c)) walk(content, `${here}/sdtContent`, cell)
          break
        }
        case "customXml":
          walk(c, here, cell)
          break
        case "bookmarkStart": {
          const name = wAttr(c, "name")
          if (name?.startsWith(BLOCK_BOOKMARK_PREFIX)) pendingBookmark = name
          else if (name?.startsWith(TABLE_BOOKMARK_PREFIX) && !cell) pendingTableBookmark = name
          break
        }
      }
    }
  }

  walk(body, "body", null)
  return blocks
}

const IMAGE_REL = /\/image$/

export const readBlocks = async (pkg: DocxPackage): Promise<OoxmlBlock[]> => {
  const images = new Map((await pkg.relationships(MAIN_PART)).filter((r) => IMAGE_REL.test(r.type)).map((r) => [r.id, r.target]))
  return parseBlocks(await pkg.requireXml(MAIN_PART), await pkg.xml("word/styles.xml"), images)
}

export const bookmarkName = (blockId: string): string => `${BLOCK_BOOKMARK_PREFIX}${blockId}`

export const tableBookmarkName = (blockId: string): string => `${TABLE_BOOKMARK_PREFIX}${blockId}`

export const blockIdOfBookmark = (name: string | null): string | null =>
  name?.startsWith(TABLE_BOOKMARK_PREFIX)
    ? name.slice(TABLE_BOOKMARK_PREFIX.length)
    : name?.startsWith(BLOCK_BOOKMARK_PREFIX)
      ? name.slice(BLOCK_BOOKMARK_PREFIX.length)
      : null

/**
 * Block neo được bằng bookmark: mọi đoạn + bảng cấp 1 (neo `_fft_` trong ô đầu). Bảng lồng (`unsupported`) và phần chữ
 * sau heading gõ chung đoạn (`tail` — đoạn đã mang bookmark của heading) thì không.
 */
export const isAnchorable = (b: OoxmlBlock): boolean => !b.tail && (isW(b.element, "p") || (b.kind === "table" && !!firstCellParagraph(b.element)))

/**
 * Ghi bookmark ẩn `_ff_<blockId>` vào đầu mỗi đoạn chưa có neo (G3). `assign` trả block id cho block;
 * trả `null` ⇒ bỏ qua. Cập nhật `block.bookmark` tại chỗ; trả số bookmark đã thêm.
 */
export const ensureBlockBookmarks = (blocks: OoxmlBlock[], assign: (b: OoxmlBlock) => string | null): number => {
  let added = 0
  let nextId: number | null = null
  for (const b of blocks) {
    if (b.bookmark || !isAnchorable(b)) continue
    const blockId = assign(b)
    if (!blockId) continue
    const doc = b.element.ownerDocument
    nextId ??= maxWId(doc, ["bookmarkStart", "bookmarkEnd"]) + 1
    const id = String(nextId++)
    const isTable = !isW(b.element, "p")
    const p = isTable ? firstCellParagraph(b.element)! : b.element
    const name = isTable ? tableBookmarkName(blockId) : bookmarkName(blockId)
    const start = wEl(doc, "bookmarkStart", { id, name })
    const end = wEl(doc, "bookmarkEnd", { id })
    const pPr = wKid(p, "pPr")
    const ref = pPr ? pPr.nextSibling : p.firstChild
    p.insertBefore(end, ref)
    p.insertBefore(start, end)
    b.bookmark = name
    added++
  }
  return added
}

export interface AnchorQuery {
  bookmark?: string | null
  para_id?: string | null
  text_hash?: string | null
}

/**
 * Tìm lại block theo neo: bookmark (chính) → paraId → text_hash duy nhất. Không đoán theo vị trí:
 * sai chỗ nguy hiểm hơn không tìm thấy (C-5 sẽ báo `CR_OLD_TEXT_MISMATCH`).
 */
export const findBlock = (blocks: OoxmlBlock[], anchor: AnchorQuery): OoxmlBlock | null => {
  if (anchor.bookmark) {
    const hit = blocks.find((b) => b.bookmark === anchor.bookmark)
    if (hit) return hit
  }
  if (anchor.para_id) {
    const hits = blocks.filter((b) => b.para_id === anchor.para_id)
    if (hits.length === 1) return hits[0]
  }
  if (anchor.text_hash) {
    // Phần chữ sau heading gõ chung đoạn không có bookmark riêng ⇒ chỉ tìm lại được theo nội dung
    const hits = blocks.filter((b) => b.text_hash === anchor.text_hash && (isAnchorable(b) || b.tail))
    if (hits.length === 1) return hits[0]
  }
  return null
}
