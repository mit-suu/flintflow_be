/**
 * Tách `word/document.xml` thành danh sách block (I-2, nút 1.5) + neo block bằng bookmark ẩn (G3).
 * FLF-171, plan §6 2A; phát hiện P0 §4.2:
 * - styleId heading bị Word bản địa hoá (`Heading1` → `u1`) ⇒ nhận heading qua `w:name` / `outlineLvl` của
 *   `styles.xml`, đi theo `basedOn`.
 * - SRS thật không dùng style heading ⇒ nhánh dự phòng theo mẫu số mục `3.2.1  Tiêu đề` (`numbering_pattern`,
 *   độ tin thấp ở I-3).
 * - Mục lục (TOC) bị loại vì trùng text với heading — FLF-343: kể cả mục lục gõ tay (`1.1 Purpose ..... 5`), và dùng làm
 *   **tín hiệu** heading (đoạn trùng tiêu đề một dòng mục lục ⇒ heading theo cấp của mục lục, `toc.ts`).
 * - FLF-343: heading không style còn nhận theo đánh số tự động (`numPr`, in đậm / chữ to, không phải style danh sách) và
 *   theo cỡ chữ (to hơn thân bài rõ rệt); in đậm / chữ to / mục lục là tín hiệu phụ (`heading_signals`) nâng độ tin ở I-3.
 * - Bookmark `_ff_<blockId>` có thể bị Word dời ra ngoài `w:p` (đoạn rỗng, ô bảng) ⇒ gắn cho đoạn kế tiếp.
 * - Bảng cấp 1 neo bằng `_fft_<blockId>` trong đoạn đầu của ô đầu (FLF-178) — nằm ngay trước bảng cũng nhận.
 */

import { BLOCK_BOOKMARK_PREFIX, TABLE_BOOKMARK_PREFIX, type DocBlockKind, type HeadingDetector, type HeadingSignal } from "../import/import.constants.js"
import type { DocxPackage } from "./package.js"
import { paragraphText, runText, textHash, visibleRuns } from "./text.js"
import { TOC_TITLE, TocIndex, isHandTocLine, parseTocLine, tocKey, type TocEntry } from "./toc.js"
import { NS, hasAncestor, isW, maxWId, wAll, wAttr, wEl, wKid, wKids } from "./xml.js"

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
  /** FLF-343: tín hiệu phụ của heading (in đậm, chữ to, trùng mục lục, đánh số tự động) — chỉ có ở `kind = heading`. */
  heading_signals?: HeadingSignal[]
  /**
   * FLF-343: số mục Word tự sinh (`numPr`, không nằm trong chữ) suy theo thứ tự heading (`3.2`) — chỉ để khớp mẫu ở I-3,
   * không ghi vào chữ của block. Heading gõ số tay / không đánh số ⇒ không có.
   */
  auto_number?: string | null
}

interface StyleInfo {
  name: string
  basedOn: string | null
  outlineLvl: number | null
  numbered: boolean
  /** `w:rPr/w:b` của style (`null` = style không đặt). */
  bold: boolean | null
  /** `w:rPr/w:sz` (nửa point). */
  size: number | null
  /** Style mặc định của đoạn (`w:default="1"`, thường là Normal). */
  isDefault: boolean
  /** `numPr` của style: `numId` + `ilvl` (thiếu ilvl ⇒ 0). */
  numId: string | null
  numIlvl: number | null
}

/** Cấp hợp lệ của `w:ilvl` (0–8); giá trị lạ ⇒ `null`. */
const ilvlOf = (v: string | null): number | null => {
  const n = Number(v ?? 0)
  return Number.isFinite(n) && n >= 0 && n <= 8 ? Math.floor(n) : null
}

/** `w:b` / `w:sz` của một `rPr`. */
const runFormat = (rPr: Element | undefined): { bold: boolean | null; size: number | null } => {
  if (!rPr) return { bold: null, size: null }
  const b = wKid(rPr, "b")
  const val = b ? wAttr(b, "val") : null
  const sz = wAttr(wKid(rPr, "sz"), "val")
  return { bold: b ? val !== "0" && val !== "false" && val !== "off" : null, size: sz && Number(sz) > 0 ? Number(sz) : null }
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
      numbered: !!(pPr && wKid(pPr, "numPr")),
      isDefault: wAttr(s, "default") === "1",
      numId: pPr ? wAttr(wKid(wKid(pPr, "numPr") ?? pPr, "numId"), "val") : null,
      numIlvl: pPr && wKid(pPr, "numPr") ? ilvlOf(wAttr(wKid(wKid(pPr, "numPr")!, "ilvl"), "val")) : null,
      ...runFormat(wKid(s, "rPr"))
    })
  }
  return map
}

/** Một cấp của danh sách đánh số (`numbering.xml`): `numFmt` (`bullet`, `decimal`…) và `lvlText` (`%1.%2`). */
interface NumLevel {
  numFmt: string | null
  lvlText: string
}
/** `numId` ⇒ các cấp của abstractNum + danh sách có phải dàn mục (có cấp `%1.%2…`). */
type NumberingInfo = Map<string, { levels: Map<number, NumLevel>; outline: boolean }>

/** Dàn mục: `lvlText` nối hai số trở lên bằng dấu chấm (`%1.%2`, `%1.%2.%3.`). */
const OUTLINE_LVL_TEXT = /%\d\.%\d/

const readNumbering = (numbering: Document | null): NumberingInfo => {
  const out: NumberingInfo = new Map()
  if (!numbering) return out
  const abstracts = new Map<string, Map<number, NumLevel>>()
  for (const a of wAll(numbering, "abstractNum")) {
    const levels = new Map<number, NumLevel>()
    for (const l of wKids(a, "lvl")) {
      const ilvl = ilvlOf(wAttr(l, "ilvl"))
      if (ilvl === null) continue
      levels.set(ilvl, { numFmt: wAttr(wKid(l, "numFmt"), "val"), lvlText: wAttr(wKid(l, "lvlText"), "val") ?? "" })
    }
    const id = wAttr(a, "abstractNumId")
    if (id) abstracts.set(id, levels)
  }
  for (const n of wAll(numbering, "num")) {
    const id = wAttr(n, "numId")
    const levels = abstracts.get(wAttr(wKid(n, "abstractNumId"), "val") ?? "")
    if (id && levels) out.set(id, { levels, outline: [...levels.values()].some((l) => OUTLINE_LVL_TEXT.test(l.lvlText)) })
  }
  return out
}

/** Cỡ chữ mặc định của tài liệu (`docDefaults/rPrDefault`), nửa point; không đặt ⇒ 22 (11pt của Word). */
const defaultSize_ = (styles: Document | null): number => {
  const def = styles ? wAll(styles, "rPrDefault")[0] : undefined
  return runFormat(def ? wKid(def, "rPr") : undefined).size ?? 22
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
const TOC_LEVEL = /^toc ([1-9])$/i
/** Style danh sách (`List Paragraph`, `List Bullet`…) — đoạn đánh số của nó là mục danh sách, không phải heading. */
const LIST_STYLE = /list/i
/** Heading phải to hơn cỡ chữ thân bài ít nhất chừng này (nửa point = 2pt). */
const LARGE_DELTA = 4
/** Heading nhận theo định dạng: ngắn, ít từ. */
const MAX_FORMAT_HEADING_CHARS = 120
const MAX_FORMAT_HEADING_WORDS = 16
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

/** Định dạng thật của đoạn: in đậm khi mọi run có chữ đều đậm; cỡ chữ = run lớn nhất (run ⇒ style đoạn ⇒ mặc định). */
const paragraphFormat = (p: Element, chain: StyleInfo[], fallbackSize: number): { bold: boolean; size: number } => {
  const styleBold = chain.find((s) => s.bold !== null)?.bold ?? false
  const styleSize = chain.find((s) => s.size !== null)?.size ?? fallbackSize
  const runs = visibleRuns(p).filter((r) => runText(r).trim())
  if (!runs.length) return { bold: false, size: styleSize }
  const formats = runs.map((r) => runFormat(wKid(r, "rPr")))
  return { bold: formats.every((f) => f.bold ?? styleBold), size: Math.max(...formats.map((f) => f.size ?? styleSize)) }
}

/**
 * Style đoạn riêng dạng tiêu đề (FLF-343): style của chính đoạn (không phải style mặc định) đặt in đậm, không phải style danh
 * sách / chú thích — "Team Title 1" của nhóm không đặt tên `heading N` cũng không có `outlineLvl`.
 */
const isTitleStyle = (chain: StyleInfo[]): boolean =>
  chain.length > 0 && !chain[0].isDefault && chain.some((s) => s.bold === true) && !chain.some((s) => LIST_STYLE.test(s.name) || CAPTION_NAME.test(s.name))

/** Đánh số tự động của đoạn (`numPr`, theo đoạn rồi style): `numId` + cấp `ilvl`; không đánh số / `numId = 0` ⇒ `null`. */
const numberingOf = (pPr: Element | undefined, chain: StyleInfo[]): { numId: string | null; ilvl: number } | null => {
  const numPr = pPr ? wKid(pPr, "numPr") : undefined
  const style = chain.find((s) => s.numbered)
  if (numPr) {
    const numId = wAttr(wKid(numPr, "numId"), "val") ?? style?.numId ?? null
    if (numId === "0") return null
    const direct = wAttr(wKid(numPr, "ilvl"), "val")
    const ilvl = direct !== null ? ilvlOf(direct) : (style?.numIlvl ?? 0)
    return ilvl === null ? null : { numId, ilvl }
  }
  if (!style || style.numId === "0") return null
  return { numId: style.numId, ilvl: style.numIlvl ?? 0 }
}

/** Chữ ngắn dạng tiêu đề (không câu văn): dùng cho heading nhận theo định dạng / đánh số tự động. */
const headingLike = (text: string): boolean => {
  const t = text.trim()
  return t.length > 0 && t.length <= MAX_FORMAT_HEADING_CHARS && t.split(/\s+/).length <= MAX_FORMAT_HEADING_WORDS && !SENTENCE_END.test(t) && !t.includes("\n")
}

/** Số đoạn tối đa một field mục lục được trải qua — quá ⇒ coi field hỏng (thiếu `end`), thôi bỏ đoạn. */
const TOC_FIELD_MAX_PARAGRAPHS = 400
const TOC_INSTR = /^\s*TOC\b/

/**
 * Theo dõi field mục lục trải qua nhiều đoạn (`fldChar begin` ở đoạn đầu, `end` ở đoạn cuối, field PAGEREF lồng trong mỗi
 * dòng). `enter(p, headingStyled)` trả `true` khi đoạn thuộc mục lục. Field hỏng không có `end` không được nuốt phần còn lại:
 * gặp đoạn có style heading / outlineLvl hoặc quá `TOC_FIELD_MAX_PARAGRAPHS` đoạn ⇒ thôi trạng thái mục lục. Đoạn có `end` mà
 * sau đó còn chữ hiển thị (chữ thân bài chung đoạn với cuối mục lục) ⇒ giữ đoạn.
 */
class TocFieldTracker {
  private depth = 0
  private tocDepth: number | null = null
  private span = 0

  enter(p: Element, headingStyled = false): boolean {
    if (this.tocDepth !== null && (headingStyled || ++this.span > TOC_FIELD_MAX_PARAGRAPHS)) {
      this.tocDepth = null
      this.depth = 0
      this.span = 0
    }
    let inToc = this.tocDepth !== null
    let endedHere = false
    let textAfterEnd = false
    for (const el of Array.from(p.getElementsByTagNameNS(NS.w, "*"))) {
      if (el.localName === "fldChar") {
        const type = wAttr(el, "fldCharType")
        if (type === "begin") this.depth++
        else if (type === "end") {
          if (this.tocDepth !== null && this.depth === this.tocDepth) {
            this.tocDepth = null
            this.span = 0
            endedHere = true
          }
          this.depth = Math.max(0, this.depth - 1)
        }
      } else if (el.localName === "instrText" && /^\s*TOC\b/.test(el.textContent ?? "") && this.tocDepth === null) {
        this.tocDepth = this.depth
        this.span = 0
        inToc = true
      } else if (endedHere && el.localName === "t" && (el.textContent ?? "").trim()) {
        textAfterEnd = true
      }
    }
    return inToc && !(endedHere && textAfterEnd)
  }
}

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

/** Kết quả quét trước (FLF-343): mục lục, dòng mục lục gõ tay, cỡ chữ thân bài, cấp theo cỡ chữ của heading không style. */
interface PreScan {
  toc: TocIndex
  handToc: Set<Element>
  defaultSize: number
  bodySize: number
  sizeLevels: Map<number, number>
  numbering: NumberingInfo
}

/** Style heading thật (tên `heading N` hoặc có `outlineLvl`) — không tính vào cỡ chữ thân bài. */
const isHeadingStyled = (pPr: Element | undefined, chain: StyleInfo[]): boolean =>
  (!!pPr && wAttr(wKid(pPr, "outlineLvl"), "val") !== null) || chain.some((s) => HEADING_NAME.test(s.name) || s.outlineLvl !== null)

const inTocSdt = (p: Element, stop: Element): boolean => {
  for (let x = p.parentNode; x && x !== stop; x = x.parentNode) if (isW(x, "sdt") && isTocSdt(x)) return true
  return false
}

/** Số dòng gõ tay liền nhau tối thiểu để nhận là mục lục khi không có tiêu đề "Mục lục" ngay trước. */
const HAND_TOC_MIN_RUN = 3

/** Đoạn thuộc mục lục (style `toc N`, field TOC, content control mục lục) — dùng chung cho quét trước và lượt chính. */
const tocParagraph = (p: Element, chain: StyleInfo[], tracker: TocFieldTracker, pPr: Element | undefined, body: Element): boolean => {
  const tocStyled = chain.some((s) => TOC_NAME.test(s.name))
  const inField = tracker.enter(p, !tocStyled && isHeadingStyled(pPr, chain))
  // field TOC dạng `fldSimple` (một đoạn); field `fldChar` do tracker theo dõi — kể cả đoạn có chữ thân bài sau `end`
  return tocStyled || inField || wAll(p, "fldSimple").some((f) => TOC_INSTR.test(wAttr(f, "instr") ?? "")) || inTocSdt(p, body)
}

/**
 * Quét trước (FLF-343). Dòng gõ tay dạng mục lục (`Tiêu đề ..... 5`, `Nhãn<tab>5`) chỉ là mục lục khi ngay sau tiêu đề "Mục
 * lục", hoặc chạy ≥ 3 dòng mà quá nửa tiêu đề trùng đoạn xuất hiện phía sau — danh sách khoá / giá trị cách bằng tab không bị
 * nuốt. Cỡ chữ của heading theo định dạng chỉ tính từ sau mục lục / heading đầu và phải dùng ≥ 2 lần (tiêu đề bìa không phải cấp 1).
 */
const preScan = (body: Element, styles: Map<string, StyleInfo>, stylesDoc: Document | null, numbering: NumberingInfo): PreScan => {
  const defaultSize = defaultSize_(stylesDoc)
  const paras = wAll(body, "p").filter((p) => !hasAncestor(p, "tbl", body))
  const tracker = new TocFieldTracker()
  const entries: TocEntry[] = []
  const handToc = new Set<Element>()
  const weights = new Map<number, number>()
  const candidates: { size: number; titleStyle: boolean; idx: number }[] = []
  const runs: { lines: { p: Element; text: string }[]; afterTitle: boolean; end: number }[] = []
  const laterKeys: { idx: number; key: string }[] = []
  let run: { p: Element; text: string }[] = []
  let runAfterTitle = false
  let lastWasTitle = false
  let bodyStart: number | null = null
  const flush = (idx: number) => {
    if (run.length) runs.push({ lines: run, afterTitle: runAfterTitle, end: idx })
    run = []
  }
  paras.forEach((p, idx) => {
    const pPr = wKid(p, "pPr")
    const chain = styleChain(styles, pPr ? wAttr(wKid(pPr, "pStyle"), "val") : null)
    const text = paragraphText(p)
    if (tocParagraph(p, chain, tracker, pPr, body)) {
      const tocStyle = chain.find((s) => TOC_NAME.test(s.name))
      const m = tocStyle ? TOC_LEVEL.exec(tocStyle.name) : null
      const e = parseTocLine(text, m ? Number(m[1]) : null)
      if (e) entries.push(e)
      bodyStart ??= idx
      return
    }
    if (!text.trim()) return
    if (isHandTocLine(text)) {
      if (!run.length) runAfterTitle = lastWasTitle
      run.push({ p, text })
      return
    }
    flush(idx)
    laterKeys.push({ idx, key: tocKey(text) })
    lastWasTitle = TOC_TITLE.test(text.trim())
    if (isHeadingStyled(pPr, chain)) {
      bodyStart ??= idx
      return
    }
    const fmt = paragraphFormat(p, chain, defaultSize)
    weights.set(fmt.size, (weights.get(fmt.size) ?? 0) + text.length)
    if (headingLike(text)) candidates.push({ size: fmt.size, titleStyle: isTitleStyle(chain), idx })
  })
  flush(paras.length)
  for (const r of runs) {
    const parsed = r.lines.map((l) => parseTocLine(l.text)).filter((e): e is TocEntry => !!e)
    const later = new Set(laterKeys.filter((k) => k.idx >= r.end).map((k) => k.key))
    const matched = parsed.filter((e) => later.has(tocKey(e.title))).length
    if (!r.afterTitle && !(r.lines.length >= HAND_TOC_MIN_RUN && matched * 2 > r.lines.length)) continue
    for (const l of r.lines) handToc.add(l.p)
    entries.push(...parsed)
    bodyStart = bodyStart === null ? r.end - r.lines.length : Math.min(bodyStart, r.end - r.lines.length)
  }
  const bodySize = [...weights].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? defaultSize
  const counts = new Map<number, number>()
  for (const c of candidates) {
    if (c.idx < (bodyStart ?? 0)) continue
    if (c.size >= bodySize + LARGE_DELTA || (c.titleStyle && c.size >= bodySize)) counts.set(c.size, (counts.get(c.size) ?? 0) + 1)
  }
  const large = [...counts].filter(([, n]) => n >= 2).map(([size]) => size).sort((a, b) => b - a)
  return { toc: new TocIndex(entries), handToc, defaultSize, bodySize, sizeLevels: new Map(large.map((size, i) => [size, Math.min(9, i + 1)])), numbering }
}

export const parseBlocks = (
  doc: Document,
  stylesDoc: Document | null = null,
  imageTargets: ReadonlyMap<string, string> = new Map(),
  numberingDoc: Document | null = null
): OoxmlBlock[] => {
  const styles = readStyles(stylesDoc)
  const body = wAll(doc, "body")[0]
  if (!body) return []
  const pre = preScan(body, styles, stylesDoc, readNumbering(numberingDoc))
  const tocTracker = new TocFieldTracker()
  /** Đã qua mục lục — chỉ sau đó đoạn không số mới được nhận là heading nhờ trùng mục lục. */
  let pastToc = false
  /** Số mục theo thứ tự heading có đánh số (gõ tay hoặc `numPr`) — suy số Word tự sinh (`auto_number`). */
  let outline: number[] = []
  const noteHeading = (level: number, text: string, autoNumbered: boolean): string | null => {
    const typed = typedNumber(text)
    if (typed) {
      outline = typed
      return null
    }
    if (!autoNumbered) return null
    const next = outline.slice(0, level - 1)
    while (next.length < level - 1) next.push(1)
    next.push((outline.length >= level ? outline[level - 1] : 0) + 1)
    outline = next
    return next.join(".")
  }
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
    // Mục lục (style, field nhiều đoạn, gõ tay) không bao giờ thành nội dung — FLF-343 dùng nó làm tín hiệu heading (`pre.toc`)
    if (tocParagraph(p, chain, tocTracker, pPr, body) || pre.handToc.has(p)) {
      pastToc = true
      return
    }
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
    let signals: HeadingSignal[] = []
    let numbering: { numId: string | null; ilvl: number } | null = null
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
      // FLF-343: heading không style — trùng một dòng mục lục, đánh số tự động in đậm / chữ to, hoặc chữ to hơn thân bài
      const fmt = paragraphFormat(p, chain, pre.defaultSize)
      const large = fmt.size >= pre.bodySize + LARGE_DELTA
      numbering = numberingOf(pPr, chain)
      // Đoạn không gõ số chỉ khớp mục lục khi đứng sau mục lục và có thêm tín hiệu định dạng (đậm / to / đánh số tự động)
      const tocHit =
        pre.toc.size && headingLike(text) ? pre.toc.find(text, { unnumbered: pastToc && (fmt.bold || large || numbering !== null) }) : null
      const listStyle = chain.some((s) => LIST_STYLE.test(s.name))
      const numLevelInfo = numbering?.numId ? pre.numbering.get(numbering.numId) : undefined
      const numFmt = numLevelInfo?.levels.get(numbering?.ilvl ?? 0)?.numFmt ?? null
      // Đánh số tự động là heading khi: không phải gạch đầu dòng, không phải style danh sách, chữ dạng tiêu đề, in đậm / to; và
      // danh sách là dàn mục (`%1.%2`) hoặc có thêm tín hiệu khác (chữ to / trùng mục lục)
      const outlineList = !!numLevelInfo?.outline
      if (level === null && tocHit) {
        level = tocHit.level
        detector = "toc"
      }
      if (
        level === null &&
        numbering !== null &&
        numFmt !== "bullet" &&
        !listStyle &&
        headingLike(text) &&
        (fmt.bold || large) &&
        (outlineList || large)
      ) {
        level = Math.min(9, numbering.ilvl + 1)
        detector = "numbering"
      }
      if (level === null && (large || (isTitleStyle(chain) && fmt.size >= pre.bodySize)) && headingLike(text) && pre.sizeLevels.has(fmt.size)) {
        level = pre.sizeLevels.get(fmt.size)!
        detector = "format"
      }
      if (level !== null) {
        kind = "heading"
        signals = [
          ...(fmt.bold ? (["bold"] as const) : []),
          ...(large ? (["large"] as const) : []),
          ...(tocHit ? (["toc"] as const) : []),
          ...(numbering !== null ? (["numpr"] as const) : [])
        ]
      } else if ((pPr && wKid(pPr, "numPr")) || chain.some((s) => s.numbered)) kind = "list_item"
    }

    // Heading gõ chung đoạn với nội dung (FLF-252) ⇒ block heading + block phần chữ sau; cả hai không sửa tại chỗ được
    // (sửa một phần đoạn sẽ ghi đè phần kia)
    const split = kind === "paragraph" ? inlineHeading(text, headingStack[headingStack.length - 1]?.text ?? null) : null
    if (split) {
      while (headingStack.length && headingStack[headingStack.length - 1].level >= split.level) headingStack.pop()
      noteHeading(split.level, split.heading, false)
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
    const headingExtra =
      kind === "heading" && level !== null
        ? { heading_signals: signals, auto_number: noteHeading(level, text, numbering !== null) }
        : {}
    push({ ...base, kind, level, heading_detector: detector, bookmark, editable: !embedded && !hasField(p), ...headingExtra })
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
  return parseBlocks(await pkg.requireXml(MAIN_PART), await pkg.xml("word/styles.xml"), images, await pkg.xml("word/numbering.xml"))
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
