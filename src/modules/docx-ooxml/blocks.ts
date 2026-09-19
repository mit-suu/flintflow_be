/**
 * Tách `word/document.xml` thành danh sách block (I-2, nút 1.5) + neo block bằng bookmark ẩn (G3).
 * FLF-171, plan §6 2A; phát hiện P0 §4.2:
 * - styleId heading bị Word bản địa hoá (`Heading1` → `u1`) ⇒ nhận heading qua `w:name` / `outlineLvl` của
 *   `styles.xml`, đi theo `basedOn`.
 * - SRS thật không dùng style heading ⇒ nhánh dự phòng theo mẫu số mục `3.2.1  Tiêu đề` (`numbering_pattern`,
 *   độ tin thấp ở I-3).
 * - Mục lục (TOC) bị loại vì trùng text với heading.
 * - Bookmark `_ff_<blockId>` có thể bị Word dời ra ngoài `w:p` (đoạn rỗng, ô bảng) ⇒ gắn cho đoạn kế tiếp.
 */

import { BLOCK_BOOKMARK_PREFIX, type DocBlockKind, type HeadingDetector } from "../import/import.constants.js"
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
  element: Element
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
/** `3.2.1  Register account` — mỗi đoạn số ≤ 2 chữ số, tiêu đề không kết thúc bằng dấu câu. */
const NUMBERED_HEADING = /^((?:[1-9]\d?)(?:\.(?:\d{1,2})){0,5})\.?[ \t ]+(\S.{0,148})$/
const SENTENCE_END = /[.;:,!?]$/

const numberingPatternLevel = (text: string): number | null => {
  const m = NUMBERED_HEADING.exec(text.trim())
  if (!m || SENTENCE_END.test(m[2].trim()) || /^\d/.test(m[2])) return null
  return m[1].split(".").length
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

/** Tách block từ DOM (hàm thuần trên DOM, không đọc zip). */
export const parseBlocks = (doc: Document, stylesDoc: Document | null = null): OoxmlBlock[] => {
  const styles = readStyles(stylesDoc)
  const body = wAll(doc, "body")[0]
  if (!body) return []
  const blocks: OoxmlBlock[] = []
  const headingStack: { level: number; text: string }[] = []
  const seenBookmarks = new Set<string>()
  let pendingBookmark: string | null = null
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
    const base = { para_id: p.getAttributeNS(NS.w14, "paraId") || null, xml_path: path, text, cell, rows: null, element: p, style_name: styleName }

    if (!text.trim()) {
      if (!hasPicture(p) && !embedded) return
      push({ ...base, kind: hasPicture(p) && !wAll(p, "txbxContent").length ? "image" : "unsupported", level: null, heading_detector: null, bookmark: takeBookmark(p), editable: false })
      return
    }

    let kind: DocBlockKind = cell ? "table_cell" : "paragraph"
    let level: number | null = null
    let detector: HeadingDetector | null = null
    if (chain.some((s) => CAPTION_NAME.test(s.name))) kind = "caption"
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
      push({ kind: "unsupported", level: null, heading_detector: null, style_name: null, bookmark: null, para_id: null, xml_path: path, text, editable: false, cell: null, rows, element: tbl })
      return
    }
    const index = tableCount++
    push({ kind: "table", level: null, heading_detector: null, style_name: null, bookmark: null, para_id: null, xml_path: path, text, editable: false, cell: null, rows, element: tbl })
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
          break
        }
      }
    }
  }

  walk(body, "body", null)
  return blocks
}

export const readBlocks = async (pkg: DocxPackage): Promise<OoxmlBlock[]> =>
  parseBlocks(await pkg.requireXml(MAIN_PART), await pkg.xml("word/styles.xml"))

export const bookmarkName = (blockId: string): string => `${BLOCK_BOOKMARK_PREFIX}${blockId}`

export const blockIdOfBookmark = (name: string | null): string | null =>
  name?.startsWith(BLOCK_BOOKMARK_PREFIX) ? name.slice(BLOCK_BOOKMARK_PREFIX.length) : null

/** Block neo được bằng bookmark: mọi đoạn (không gồm bảng — bảng neo qua vị trí). */
export const isAnchorable = (b: OoxmlBlock): boolean => isW(b.element, "p")

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
    const name = bookmarkName(blockId)
    const start = wEl(doc, "bookmarkStart", { id, name })
    const end = wEl(doc, "bookmarkEnd", { id })
    const pPr = wKid(b.element, "pPr")
    const ref = pPr ? pPr.nextSibling : b.element.firstChild
    b.element.insertBefore(end, ref)
    b.element.insertBefore(start, end)
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
    const hits = blocks.filter((b) => b.text_hash === anchor.text_hash && isAnchorable(b))
    if (hits.length === 1) return hits[0]
  }
  return null
}
