/**
 * Chép khối OOXML của một mục từ gói nguồn (file nền cũ / snapshot) sang gói đích (mẫu mới), dưới heading mẫu đích.
 *
 * - Style đoạn / bảng của nguồn quy về **vai trò** (Normal, heading N, list, caption, toc N, footnote text, table) rồi
 *   đổi sang style cùng vai trò của mẫu đích; run chỉ giữ b / i / u / strike / sub / sup (bỏ font, màu, cỡ, tô nền).
 * - Numbering và footnote chép sang với id mới; bookmark đổi id (và tên nếu trùng); mục lục để Word tự cập nhật.
 * - Rels theo allow-list: image (nhúng, định dạng biết), hyperlink `http(s)` (giữ `TargetMode="External"`), footnote, numbering.
 *   OLE, `altChunk`, `subDoc`, ảnh / link ngoài, chart… bị bỏ và ghi vào `dropped`.
 * - Lỗi của từng mục không làm hỏng cả file: mục lỗi trả `ok: false` và không nối nút nào vào thân văn bản đích (mọi việc có thể
 *   lỗi làm ở bước chuẩn bị trên bản sao). Ghi part (ảnh, rels, numbering, footnote) là best-effort: mục lỗi giữa chừng có thể để lại
 *   part / rels mồ côi — `pruneUnreferencedParts` dọn ở bước cuối của file nền.
 */
import { MAIN_PART, relsPathOf, type DocxPackage } from "../docx-ooxml/index.js"
import { NS, insertAfter, isW, maxWId, removeNode, unwrap, wAll, wAttr, wEl, wKid, wKids } from "../docx-ooxml/xml.js"
import { BLOCK_BOOKMARK_PREFIX, TABLE_BOOKMARK_PREFIX } from "../import/import.constants.js"

// ─── kiểu công khai ──────────────────────────────────────────────

export type DroppedKind =
  | "ole"
  | "alt_chunk"
  | "sub_document"
  | "attached_template"
  | "external_image"
  | "external_link"
  | "unsupported_part"
  | "unsupported_image"
  | "missing_relationship"
  | "endnote"
  | "footnote_missing"

export interface DroppedItem {
  kind: DroppedKind
  detail?: string
}

export type TransplantErrorCode = "unsafe_field" | "unsupported_numbering" | "invalid_input" | "unexpected"

export interface TransplantRequest {
  /** Khoá mục do người gọi đặt (chỉ để đối chiếu kết quả). */
  key: string
  /** Phần tử con của `w:body` trong **gói nguồn** (theo thứ tự tài liệu), không gồm heading của mục. */
  elements: readonly Element[]
  /** Nút con của `w:body` trong gói đích — khối được chèn ngay sau nút này, đúng thứ tự `elements`. */
  after: Element
  /**
   * Cộng vào cấp heading của các đoạn heading được chép (mục con / phần tử trong khối, heading gốc của mục giữ lại) — để khớp cấp của
   * mẫu đích khi mẫu đích lồng sâu / nông hơn file cũ (FPTU: "3." là Heading 2, file cũ Heading 1). Mặc định 0; kết quả kẹp 1–9.
   */
  headingShift?: number
}

/** Dịch vai trò heading `h<n>` thêm `shift` cấp (kẹp 1–9); vai trò khác giữ nguyên. */
const shiftHeadingRole = (role: ParaRole, shift: number): ParaRole => {
  const m = /^h(\d)$/.exec(role)
  return m && shift ? (`h${Math.min(9, Math.max(1, Number(m[1]) + shift))}` as ParaRole) : role
}

export interface TransplantResult {
  key: string
  ok: boolean
  /** Nút đã chèn vào gói đích (rỗng khi `ok = false`). */
  inserted: Element[]
  dropped: DroppedItem[]
  warnings: string[]
  error?: { code: TransplantErrorCode; message: string }
}

// ─── hằng số ─────────────────────────────────────────────────────

const R = NS.r
const RT = {
  image: `${R}/image`,
  hyperlink: `${R}/hyperlink`,
  footnotes: `${R}/footnotes`,
  numbering: `${R}/numbering`
} as const
const CT = {
  footnotes: "application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml",
  numbering: "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"
} as const
const PART = { numbering: "word/numbering.xml", footnotes: "word/footnotes.xml", styles: "word/styles.xml" } as const

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  svg: "image/svg+xml",
  emf: "image/x-emf",
  wmf: "image/x-wmf"
}

const HTTP = /^https?:\/\//i
/** Kiểu quan hệ nguy hiểm: không bao giờ được nằm trong gói kết quả. */
const DANGEROUS_REL = /\/(attachedTemplate|oleObject|package|subDocument|aFChunk|frame|control|activeXControlBinary|vbaProject|vbaData|ui\/extensibility)$/
/** Field kéo nội dung / chạy lệnh / hỏi người dùng khi cập nhật: không bao giờ được chép sang file nền. */
const BLOCKED_FIELD = /^\s*(INCLUDETEXT|INCLUDEPICTURE|INCLUDE|LINK|DDEAUTO|DDE|IMPORT|DATABASE|MACROBUTTON|AUTOTEXTLIST|AUTOTEXT|GLOSSARY|PRINT|ASK|FILLIN)\b/i

/** Phần tử bỏ hẳn / bóc vỏ trước khi xử lý (track changes, comment, content control, thẻ thông minh…). */
const DROP_ELEMENTS = new Set(["del", "moveFrom", "proofErr", "permStart", "permEnd", "commentRangeStart", "commentRangeEnd", "moveFromRangeStart", "moveFromRangeEnd", "moveToRangeStart", "moveToRangeEnd", "sectPr"])
const UNWRAP_ELEMENTS = new Set(["ins", "moveTo", "smartTag", "customXml"])

/** Con của `w:pPr` được giữ theo nhóm vai trò (giữ đúng thứ tự gốc ⇒ đúng thứ tự schema). */
const PPR_KEEP_BODY = new Set(["keepNext", "keepLines", "pageBreakBefore", "jc"])
const PPR_KEEP_LIST = new Set(["keepNext", "keepLines"])
const PPR_KEEP_CAPTION = new Set(["keepNext"])
const RPR_KEEP = new Set(["b", "bCs", "i", "iCs", "strike", "dstrike", "u", "vertAlign"])
const TBLPR_KEEP = new Set(["tblW", "jc", "tblLayout", "tblLook"])
const TRPR_KEEP = new Set(["cantSplit", "tblHeader", "trHeight"])
const TCPR_KEEP = new Set(["tcW", "gridSpan", "hMerge", "vMerge", "vAlign"])
const UNIT_ELEMENTS = new Set(["drawing", "pict", "object"])

// ─── style ───────────────────────────────────────────────────────

type ParaRole = "normal" | "list" | "caption" | "footnoteText" | `h${number}` | `toc${number}`

interface StyleDef {
  id: string
  name: string
  type: string
  basedOn: string | null
  outline: number | null
  numId: string | null
  ilvl: string | null
  isDefault: boolean
}

const readStyleDefs = async (pkg: DocxPackage): Promise<StyleDef[]> => {
  const doc = await pkg.xml(PART.styles)
  if (!doc) return []
  return wAll(doc, "style").map((s) => {
    const pPr = wKid(s, "pPr")
    const numPr = pPr && wKid(pPr, "numPr")
    const outline = pPr ? wAttr(wKid(pPr, "outlineLvl"), "val") : null
    return {
      id: wAttr(s, "styleId") ?? "",
      name: wAttr(wKid(s, "name"), "val") ?? "",
      type: wAttr(s, "type") ?? "paragraph",
      basedOn: wAttr(wKid(s, "basedOn"), "val"),
      outline: outline === null ? null : Number(outline),
      numId: numPr ? wAttr(wKid(numPr, "numId"), "val") : null,
      ilvl: numPr ? wAttr(wKid(numPr, "ilvl"), "val") : null,
      isDefault: wAttr(s, "default") === "1"
    }
  })
}

const HEADING_NAME = /^heading\s*([1-9])$/i
const TOC_NAME = /^toc\s*([1-9])$/i

/** Style + các style cha (`basedOn`), chặn vòng lặp. */
const styleChain = (defs: ReadonlyMap<string, StyleDef>, id: string | null): StyleDef[] => {
  const out: StyleDef[] = []
  for (let cur = id ? defs.get(id) : undefined; cur && !out.includes(cur); cur = cur.basedOn ? defs.get(cur.basedOn) : undefined) out.push(cur)
  return out
}

/** Style của mẫu đích theo vai trò. Không có style cùng vai trò ⇒ rơi về Normal (kèm cảnh báo ở người gọi). */
class TargetStyles {
  private readonly byName = new Map<string, StyleDef>()
  private readonly headingByOutline = new Map<number, StyleDef>()
  private readonly defaultPara: StyleDef | undefined
  private readonly defaultTable: StyleDef | undefined

  constructor(defs: readonly StyleDef[]) {
    for (const d of defs) {
      this.byName.set(`${d.type}:${d.name.toLowerCase()}`, d)
      if (d.type === "paragraph" && d.outline !== null && d.outline < 9 && !TOC_NAME.test(d.name) && !this.headingByOutline.has(d.outline)) this.headingByOutline.set(d.outline, d)
    }
    this.defaultPara = defs.find((d) => d.type === "paragraph" && d.isDefault)
    this.defaultTable = defs.find((d) => d.type === "table" && d.isDefault)
  }

  private named(type: string, ...names: string[]): StyleDef | undefined {
    for (const n of names) {
      const d = this.byName.get(`${type}:${n}`)
      if (d) return d
    }
    return undefined
  }

  /** `exact = false` ⇒ mẫu đích không có style cùng vai trò, đã rơi về Normal (`id` = style mặc định hoặc `null`). */
  paragraph(role: ParaRole): { id: string | null; exact: boolean } {
    if (role === "normal") return { id: this.defaultPara?.id ?? null, exact: true }
    let hit: StyleDef | undefined
    if (role === "list") hit = this.named("paragraph", "list paragraph")
    else if (role === "caption") hit = this.named("paragraph", "caption")
    else if (role === "footnoteText") hit = this.named("paragraph", "footnote text")
    else if (role.startsWith("toc")) hit = this.named("paragraph", `toc ${role.slice(3)}`)
    else hit = this.named("paragraph", `heading ${role.slice(1)}`) ?? this.headingByOutline.get(Number(role.slice(1)) - 1)
    return hit ? { id: hit.id, exact: true } : { id: this.defaultPara?.id ?? null, exact: false }
  }

  /** Bảng: `Table Grid` nếu có, không thì style bảng mặc định. */
  table(): { id: string | null; exact: boolean } {
    const hit = this.named("table", "table grid")
    if (hit) return { id: hit.id, exact: true }
    return { id: this.defaultTable?.id ?? null, exact: false }
  }

  /** Style ký tự cùng tên (Hyperlink, Strong, Footnote Reference…); không có ⇒ `null`. */
  char(name: string): string | null {
    return this.named("character", name.toLowerCase())?.id ?? null
  }
}

const sourceRole = (pPr: Element | undefined, chain: readonly StyleDef[], hasNum: boolean): ParaRole => {
  const direct = pPr ? wAttr(wKid(pPr, "outlineLvl"), "val") : null
  let level = direct !== null && Number(direct) < 9 ? Number(direct) + 1 : null
  for (const s of chain) {
    if (level !== null) break
    const m = HEADING_NAME.exec(s.name)
    if (m) level = Number(m[1])
    else if (s.outline !== null && s.outline < 9) level = s.outline + 1
  }
  if (level !== null) return `h${level}`
  for (const s of chain) {
    const toc = TOC_NAME.exec(s.name)
    if (toc) return `toc${Number(toc[1])}`
  }
  if (chain.some((s) => /^caption$/i.test(s.name))) return "caption"
  if (chain.some((s) => /^footnote text$/i.test(s.name))) return "footnoteText"
  if (hasNum || chain.some((s) => /list/i.test(s.name))) return "list"
  return "normal"
}

// ─── DOM helpers ─────────────────────────────────────────────────

/**
 * Lệnh của từng field trong `holder`, ghép từ mọi `instrText` giữa `fldChar begin` và `separate` / `end` — qua nhiều run và nhiều
 * đoạn (Word hay tách lệnh thành nhiều run). Kèm `fldSimple@instr`, `instrText` lạc ngoài field và field chưa đóng.
 */
const fieldInstructions = (holder: Element): string[] => {
  const out: string[] = []
  const stack: { text: string; inResult: boolean }[] = []
  for (const el of Array.from(holder.getElementsByTagName("*"))) {
    if (!isW(el)) continue
    if (el.localName === "fldChar") {
      const type = wAttr(el, "fldCharType")
      const top = stack[stack.length - 1]
      if (type === "begin") stack.push({ text: "", inResult: false })
      else if (type === "separate" && top) top.inResult = true
      else if (type === "end") {
        const done = stack.pop()
        if (done) out.push(done.text)
      }
    } else if (el.localName === "instrText") {
      const top = stack[stack.length - 1]
      if (top && !top.inResult) top.text += el.textContent ?? ""
      else out.push(el.textContent ?? "")
    } else if (el.localName === "fldSimple") out.push(wAttr(el, "instr") ?? "")
  }
  for (const open of stack) out.push(open.text)
  return out
}

/** `HYPERLINK` có đích không phải http(s) (kể cả khi có `\\l` kèm đích khác) ⇒ trả đích đó; hợp lệ / không phải HYPERLINK ⇒ `null`. */
const unsafeHyperlinkTarget = (instruction: string): string | null => {
  const m = /^\s*HYPERLINK\b([\s\S]*)$/i.exec(instruction)
  if (!m) return null
  const tokens = Array.from(m[1].matchAll(/"([^"]*)"|(\S+)/g)).map((t) => ({ value: t[1] ?? t[2], quoted: t[1] !== undefined }))
  const targets: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (!t.quoted && t.value.startsWith("\\")) {
      // \l (neo), \o (gợi ý), \t (khung) nhận một đối số; \m, \n không
      if (/^\\[lot]$/i.test(t.value)) i++
      continue
    }
    targets.push(t.value)
  }
  return targets.find((t) => !HTTP.test(t)) ?? null
}

const rAttrs = (el: Element): Attr[] => Array.from(el.attributes).filter((a) => a.namespaceURI === R)

const descendants = (el: Element): Element[] => Array.from(el.getElementsByTagName("*"))

/** Chỉ giữ con `w:` có tên trong `keep` (con không thuộc `w:` cũng bỏ). */
const keepChildren = (el: Element, keep: ReadonlySet<string>): void => {
  for (const c of Array.from(el.childNodes)) if (!(isW(c) && keep.has(c.localName))) el.removeChild(c)
}

/** Ngoài cùng trong chuỗi tổ tiên là drawing / pict / object / AlternateContent — đơn vị bỏ trọn khi rels không được phép. */
const outermostUnit = (el: Element): Element => {
  let found: Element = el
  for (let x = el.parentNode; x && x.nodeType === 1; x = x.parentNode) {
    const e = x as Element
    if ((isW(e) && UNIT_ELEMENTS.has(e.localName)) || (e.namespaceURI === NS.mc && e.localName === "AlternateContent")) found = e
  }
  return found
}

const maxAttr = (doc: Document | null, local: string, attr: string): number => {
  let max = 0
  if (doc) for (const el of wAll(doc, local)) max = Math.max(max, Number(wAttr(el, attr)) || 0)
  return max
}

/** Bỏ vỏ track changes / content control / thẻ thông minh, bỏ comment + vết sửa, thay `mc:AlternateContent` bằng nhánh Choice. */
const normalize = (holder: Element): void => {
  for (const ac of Array.from(holder.getElementsByTagNameNS(NS.mc, "AlternateContent"))) {
    const kids = Array.from(ac.childNodes).filter((c): c is Element => c.nodeType === 1)
    const pick = kids.find((c) => c.localName === "Choice") ?? kids.find((c) => c.localName === "Fallback")
    if (pick) while (pick.firstChild) ac.parentNode!.insertBefore(pick.firstChild, ac)
    removeNode(ac)
  }
  for (const el of descendants(holder)) if (isW(el) && DROP_ELEMENTS.has(el.localName)) removeNode(el)
  for (const sdt of wAll(holder, "sdt")) {
    for (const k of wKids(sdt)) {
      if (k.localName === "sdtContent") unwrap(k)
      else removeNode(k)
    }
    unwrap(sdt)
  }
  for (const el of descendants(holder)) if (isW(el) && UNWRAP_ELEMENTS.has(el.localName)) unwrap(el)
}

class SectionError extends Error {
  constructor(
    readonly code: TransplantErrorCode,
    message: string
  ) {
    super(message)
  }
}

// ─── môi trường dùng chung cả lượt chép ─────────────────────────

interface Owner {
  srcPart: string
  tgtPart: string
}

interface Env {
  source: DocxPackage
  target: DocxPackage
  srcDoc: Document
  targetDoc: Document
  srcStyles: Map<string, StyleDef>
  tgtStyles: TargetStyles
  counters: { annotation: number; docPr: number; footnote: number; abstractNum: number; num: number; media: number }
  /** Đã ghi vào gói đích (mục trước thành công) — dùng lại cho mục sau. */
  committed: { rels: Map<string, string>; media: Map<string, string>; numMap: Map<string, string>; absMap: Map<string, string>; bookmarks: Set<string> }
  footnotesTarget: string
  /** Bề rộng vùng chữ (twip) của trang cuối mỗi phía; `null` = không đọc được. Dùng co giãn độ rộng bảng chép sang. */
  textWidth: { source: number | null; target: number | null }
  srcRelsCache: Map<string, ReturnType<DocxPackage["relationships"]>>
  srcPartCache: Map<string, Promise<{ name: string; doc: Document } | null>>
}

interface PendingRel {
  owner: string
  type: string
  target: string
  external: boolean
  setters: Array<(rid: string) => void>
}

interface Pending {
  rels: Map<string, PendingRel>
  media: Map<string, { name: string; data: Buffer; contentType: string }>
  numMap: Map<string, string>
  absMap: Map<string, string>
  abstractNums: Element[]
  nums: Element[]
  footnoteMap: Map<string, string>
  footnotes: Element[]
  bookmarks: Set<string>
  dropped: DroppedItem[]
  warnings: Set<string>
}

const newPending = (): Pending => ({
  rels: new Map(),
  media: new Map(),
  numMap: new Map(),
  absMap: new Map(),
  abstractNums: [],
  nums: [],
  footnoteMap: new Map(),
  footnotes: [],
  bookmarks: new Set(),
  dropped: [],
  warnings: new Set()
})

/** Part theo kiểu quan hệ từ `document.xml` (hoặc tên mặc định nếu gói có); không có ⇒ `null`. */
const partOfType = async (pkg: DocxPackage, type: string, fallback: string): Promise<string | null> => {
  const rel = (await pkg.relationships(MAIN_PART)).find((r) => r.type === type && r.targetMode !== "External")
  const name = (rel ? await pkg.resolveRelationship(MAIN_PART, rel.id) : null) ?? fallback
  return pkg.has(name) ? name : null
}

/** Bề rộng vùng chữ (twip) theo `w:sectPr` cuối của body: khổ giấy trừ lề trái / phải. */
const pageTextWidth = (doc: Document): number | null => {
  const body = wKid(doc.documentElement, "body")
  const sect = body && wKid(body, "sectPr")
  const size = sect && wKid(sect, "pgSz")
  const margin = sect && wKid(sect, "pgMar")
  if (!size || !margin) return null
  const width = Number(wAttr(size, "w")) - (Number(wAttr(margin, "left")) || 0) - (Number(wAttr(margin, "right")) || 0)
  return Number.isFinite(width) && width > 0 ? width : null
}

/** Tổng độ rộng cột (twip) của bảng theo `w:tblGrid`; không có lưới ⇒ cộng `tcW` dạng dxa của hàng đầu. */
const tableWidth = (tbl: Element): number => {
  const grid = wKid(tbl, "tblGrid")
  const cols = grid ? wKids(grid, "gridCol").map((c) => Number(wAttr(c, "w")) || 0) : []
  if (cols.some((w) => w > 0)) return cols.reduce((a, b) => a + b, 0)
  const first = wKid(tbl, "tr")
  return first
    ? wKids(first, "tc").reduce((sum, tc) => {
        const tcW = wKid(wKid(tc, "tcPr") ?? tc, "tcW")
        return sum + (wAttr(tcW, "type") === "dxa" ? Number(wAttr(tcW, "w")) || 0 : 0)
      }, 0)
    : 0
}

/** Nhân độ rộng dạng dxa (lưới cột, `tcW`, `tblW`) với `ratio`; kiểu pct / auto giữ nguyên. */
const scaleTableWidths = (tbl: Element, ratio: number): void => {
  const scale = (el: Element | undefined): void => {
    const v = Number(wAttr(el, "w"))
    if (el && Number.isFinite(v) && v > 0) el.setAttributeNS(NS.w, "w:w", String(Math.max(1, Math.round(v * ratio))))
  }
  const grid = wKid(tbl, "tblGrid")
  if (grid) for (const c of wKids(grid, "gridCol")) scale(c)
  const tblW = wKid(wKid(tbl, "tblPr") ?? tbl, "tblW")
  if (tblW && wAttr(tblW, "type") === "dxa") scale(tblW)
  for (const tr of wKids(tbl, "tr"))
    for (const tc of wKids(tr, "tc")) {
      const tcW = wKid(wKid(tc, "tcPr") ?? tc, "tcW")
      if (tcW && wAttr(tcW, "type") === "dxa") scale(tcW)
    }
}

const createEnv = async (source: DocxPackage, target: DocxPackage): Promise<Env> => {
  const srcDoc = await source.requireXml(MAIN_PART)
  const targetDoc = await target.requireXml(MAIN_PART)
  const [srcDefs, tgtDefs] = await Promise.all([readStyleDefs(source), readStyleDefs(target)])
  const numberingName = await partOfType(target, RT.numbering, PART.numbering)
  const footnotesName = await partOfType(target, RT.footnotes, PART.footnotes)
  const numbering = numberingName ? await target.xml(numberingName) : null
  const footnotes = footnotesName ? await target.xml(footnotesName) : null
  const docPrMax = Math.max(0, ...descendants(targetDoc.documentElement).filter((e) => e.localName === "docPr").map((e) => Number(e.getAttribute("id")) || 0))
  const bookmarks = new Set(wAll(targetDoc, "bookmarkStart").map((b) => wAttr(b, "name") ?? ""))
  return {
    source,
    target,
    srcDoc,
    targetDoc,
    srcStyles: new Map(srcDefs.map((d) => [d.id, d])),
    tgtStyles: new TargetStyles(tgtDefs),
    counters: {
      annotation: maxWId(targetDoc, ["bookmarkStart", "bookmarkEnd", "ins", "del", "moveFrom", "moveTo", "commentRangeStart", "commentRangeEnd"]),
      docPr: docPrMax,
      footnote: Math.max(0, maxWId(footnotes ?? targetDoc, ["footnote"])),
      abstractNum: maxAttr(numbering, "abstractNum", "abstractNumId"),
      num: maxAttr(numbering, "num", "numId"),
      media: 0
    },
    committed: { rels: new Map(), media: new Map(), numMap: new Map(), absMap: new Map(), bookmarks },
    footnotesTarget: footnotesName ?? PART.footnotes,
    textWidth: { source: pageTextWidth(srcDoc), target: pageTextWidth(targetDoc) },
    srcRelsCache: new Map(),
    srcPartCache: new Map()
  }
}

// ─── dựng một mục (chuẩn bị trên bản sao) ───────────────────────

class SectionBuilder {
  readonly pending = newPending()
  /** Thuộc tính `r:*` đã có bộ ghi rels xử lý (phần tử → tên cục bộ); thuộc tính còn lại là của nguồn, không được lọt sang đích. */
  private readonly claimed = new WeakMap<Element, Set<string>>()
  private readonly seen = new Set<Element>()
  private readonly renames = new Map<string, string>()

  constructor(
    private readonly env: Env,
    private readonly headingShift = 0
  ) {}

  private get doc(): Document {
    return this.env.targetDoc
  }

  private srcRels(part: string) {
    let rels = this.env.srcRelsCache.get(part)
    if (!rels) {
      rels = this.env.source.relationships(part)
      this.env.srcRelsCache.set(part, rels)
    }
    return rels
  }

  /** Part nguồn theo kiểu quan hệ (numbering / footnotes), parse một lần cho cả lượt. */
  private srcPart(type: string, fallback: string): Promise<{ name: string; doc: Document } | null> {
    let cached = this.env.srcPartCache.get(type)
    if (!cached) {
      cached = (async () => {
        const name = await partOfType(this.env.source, type, fallback)
        const doc = name ? await this.env.source.xml(name) : null
        return name && doc ? { name, doc } : null
      })()
      this.env.srcPartCache.set(type, cached)
    }
    return cached
  }

  private drop(kind: DroppedKind, detail?: string): void {
    this.pending.dropped.push({ kind, detail })
  }

  private claim(el: Element, attr: Attr): void {
    const set = this.claimed.get(el) ?? new Set<string>()
    set.add(attr.localName)
    this.claimed.set(el, set)
  }

  /** Quét `holder`: phần tử còn mang `r:*` chưa được bộ ghi rels nhận (phần tử lạ, `w:subDoc`, `w14:contentPart`…) ⇒ bỏ cả đơn vị. */
  private sweep(holder: Element): void {
    const attached = (el: Element): boolean => {
      for (let n: Node | null = el; n; n = n.parentNode) if (n === holder) return true
      return false
    }
    for (const el of Array.from(holder.getElementsByTagName("*"))) {
      if (!attached(el)) continue
      const stray = rAttrs(el).filter((a) => !this.claimed.get(el)?.has(a.localName))
      if (!stray.length) continue
      this.drop("unsupported_part", `${el.localName}@${stray[0].name}`)
      removeNode(outermostUnit(el))
    }
  }

  /** Đăng ký rels cần tạo ở gói đích; `setter` gán `r:id` thật sau khi ghi. */
  private registerRel(owner: Owner, type: string, target: string, external: boolean, setter: (rid: string) => void): void {
    const key = `${owner.tgtPart}|${type}|${external ? "ext" : "int"}|${target}`
    const done = this.env.committed.rels.get(key)
    if (done) return setter(done)
    const entry = this.pending.rels.get(key) ?? { owner: owner.tgtPart, type, target, external, setters: [] }
    entry.setters.push(setter)
    this.pending.rels.set(key, entry)
  }

  /** Vai trò → style đích; không có style cùng vai trò thì cảnh báo (một lần mỗi vai trò). */
  private paragraphStyle(role: ParaRole): string | null {
    const s = this.env.tgtStyles.paragraph(role)
    if (!s.exact) this.pending.warnings.add(`Mẫu đích không có style cho vai trò "${role}", dùng Normal`)
    return s.id
  }

  // ── khối cấp body ──

  async build(elements: readonly Element[]): Promise<Element[]> {
    const holder = this.doc.createElementNS(NS.w, "w:body")
    for (const el of elements) holder.appendChild(this.doc.importNode(el, true))
    normalize(holder)
    this.checkFields(holder)
    await this.blocks(holder, { srcPart: MAIN_PART, tgtPart: MAIN_PART })
    this.sweep(holder)
    this.bookmarks(holder)
    this.finalize(holder)
    const out = Array.from(holder.childNodes).filter((n): n is Element => n.nodeType === 1)
    for (const n of out) holder.removeChild(n)
    return out
  }

  private async blocks(container: Element, owner: Owner, tableRatio?: number): Promise<void> {
    for (const child of wKids(container)) {
      switch (child.localName) {
        case "p":
          await this.paragraph(child, owner)
          break
        case "tbl":
          await this.table(child, owner, tableRatio)
          break
        case "altChunk":
          this.drop("alt_chunk")
          removeNode(child)
          break
        case "subDoc":
          this.drop("sub_document")
          removeNode(child)
          break
        default:
      }
    }
  }

  /**
   * Bảng cấp 1: co giãn theo tỉ lệ vùng chữ đích / nguồn rồi chặn không vượt vùng chữ đích (bảng không tràn lề mẫu mới).
   * Bảng lồng nhận `parentRatio` của bảng cha để giữ tương quan với ô chứa.
   */
  private async table(tbl: Element, owner: Owner, parentRatio?: number): Promise<void> {
    const { source: srcWidth, target: tgtWidth } = this.env.textWidth
    let ratio = parentRatio ?? 1
    if (parentRatio === undefined && tgtWidth) {
      ratio = srcWidth ? tgtWidth / srcWidth : 1
      const own = tableWidth(tbl)
      if (own * ratio > tgtWidth) ratio = tgtWidth / own
    }
    if (Math.abs(ratio - 1) > 0.005) scaleTableWidths(tbl, ratio)
    const pr = wKid(tbl, "tblPr")
    if (pr) keepChildren(pr, TBLPR_KEEP)
    const props = pr ?? wEl(this.doc, "tblPr")
    const style = this.env.tgtStyles.table()
    if (!style.exact) this.pending.warnings.add('Mẫu đích không có style bảng "Table Grid"')
    if (style.id) props.insertBefore(wEl(this.doc, "tblStyle", { val: style.id }), props.firstChild)
    if (!pr) tbl.insertBefore(props, tbl.firstChild)
    for (const tr of wKids(tbl, "tr")) {
      const trPr = wKid(tr, "trPr")
      if (trPr) keepChildren(trPr, TRPR_KEEP)
      for (const tc of wKids(tr, "tc")) {
        const tcPr = wKid(tc, "tcPr")
        if (tcPr) keepChildren(tcPr, TCPR_KEEP)
        await this.blocks(tc, owner, ratio)
      }
    }
  }

  // ── đoạn ──

  private effectiveNum(pPr: Element | undefined, chain: readonly StyleDef[]): { numId: string; ilvl: string } | null {
    const direct = pPr ? wKid(pPr, "numPr") : undefined
    let numId = direct ? wAttr(wKid(direct, "numId"), "val") : null
    let ilvl = direct ? wAttr(wKid(direct, "ilvl"), "val") : null
    if (numId === null) {
      const s = chain.find((c) => c.numId !== null)
      numId = s?.numId ?? null
      ilvl ??= s?.ilvl ?? null
    }
    return numId && numId !== "0" ? { numId, ilvl: ilvl ?? "0" } : null
  }

  private async paragraph(p: Element, owner: Owner): Promise<void> {
    if (this.seen.has(p)) return
    this.seen.add(p)
    const pPr = wKid(p, "pPr")
    const chain = styleChain(this.env.srcStyles, pPr ? wAttr(wKid(pPr, "pStyle"), "val") : null)
    const num = this.effectiveNum(pPr, chain)
    const role = shiftHeadingRole(sourceRole(pPr, chain, num !== null), this.headingShift)
    const group = role === "normal" || role === "footnoteText" ? PPR_KEEP_BODY : role === "list" ? PPR_KEEP_LIST : role === "caption" ? PPR_KEEP_CAPTION : new Set<string>()

    const fresh = wEl(this.doc, "pPr")
    const styleId = this.paragraphStyle(role)
    if (styleId) fresh.appendChild(wEl(this.doc, "pStyle", { val: styleId }))
    for (const c of pPr ? wKids(pPr) : []) if (group.has(c.localName)) fresh.appendChild(c.cloneNode(true))
    if (role === "list" && num) {
      const newNum = await this.mapNumId(num.numId)
      if (newNum) {
        const numPr = wEl(this.doc, "numPr")
        numPr.appendChild(wEl(this.doc, "ilvl", { val: num.ilvl }))
        numPr.appendChild(wEl(this.doc, "numId", { val: newNum }))
        fresh.insertBefore(numPr, wKid(fresh, "jc") ?? null)
      }
    }
    if (pPr) removeNode(pPr)
    if (fresh.firstChild) p.insertBefore(fresh, p.firstChild)

    await this.inline(p, owner)
    // Đoạn trong textbox / bảng lồng nằm trong drawing: `inline` → `unit` đã đi qua `txbxContent`
  }

  /** Kiểm lệnh đầy đủ của mọi field trong `holder` (ghép qua run / đoạn) — field nguy hiểm ⇒ cả mục lỗi. */
  private checkFields(holder: Element): void {
    for (const instruction of fieldInstructions(holder)) {
      if (BLOCKED_FIELD.test(instruction)) throw new SectionError("unsafe_field", `Field bị chặn: ${instruction.trim().slice(0, 40)}`)
      const bad = unsafeHyperlinkTarget(instruction)
      if (bad !== null) throw new SectionError("unsafe_field", `HYPERLINK không phải http(s): ${bad.slice(0, 40)}`)
    }
  }

  private async inline(parent: Element, owner: Owner): Promise<void> {
    for (const el of Array.from(parent.childNodes)) {
      if (el.nodeType !== 1 || !isW(el)) continue
      const e = el as Element
      if (e.localName === "r") await this.run(e, owner)
      else if (e.localName === "fldSimple") await this.inline(e, owner)
      else if (e.localName === "hyperlink") await this.hyperlink(e, owner)
      else if (e.localName === "subDoc") {
        this.drop("sub_document")
        removeNode(e)
      }
    }
  }

  private async hyperlink(h: Element, owner: Owner): Promise<void> {
    const rid = h.hasAttributeNS(R, "id") ? h.getAttributeNS(R, "id") : null
    let keep = true
    if (rid !== null) {
      const rel = (await this.srcRels(owner.srcPart)).find((r) => r.id === rid)
      if (rel && rel.type === RT.hyperlink && rel.targetMode === "External" && HTTP.test(rel.target)) {
        this.registerRel(owner, RT.hyperlink, rel.target, true, (newId) => h.setAttributeNS(R, "r:id", newId))
        for (const a of rAttrs(h)) this.claim(h, a)
      } else {
        this.drop("external_link", rel?.target)
        keep = false
      }
    }
    await this.inline(h, owner)
    if (!keep) unwrap(h)
  }

  // ── run ──

  private async run(r: Element, owner: Owner): Promise<void> {
    const rPr = wKid(r, "rPr")
    const hasNoteRef = !!(wKid(r, "footnoteRef") ?? wKid(r, "footnoteReference"))
    const fresh = wEl(this.doc, "rPr")
    const srcStyle = rPr ? wAttr(wKid(rPr, "rStyle"), "val") : null
    const mapped = srcStyle ? this.env.tgtStyles.char(this.env.srcStyles.get(srcStyle)?.name ?? "") : null
    if (mapped) fresh.appendChild(wEl(this.doc, "rStyle", { val: mapped }))
    for (const c of rPr ? wKids(rPr) : []) if (RPR_KEEP.has(c.localName)) fresh.appendChild(c.cloneNode(true))
    // Mẫu đích không có style "Footnote Reference" thì tự nâng chỉ số trên
    if (hasNoteRef && !mapped && !wKid(fresh, "vertAlign")) fresh.appendChild(wEl(this.doc, "vertAlign", { val: "superscript" }))
    if (rPr) removeNode(rPr)
    if (fresh.firstChild) r.insertBefore(fresh, r.firstChild)

    for (const c of wKids(r)) {
      if (UNIT_ELEMENTS.has(c.localName)) await this.unit(c, owner)
      else if (c.localName === "footnoteReference") await this.footnote(c)
      else if (c.localName === "endnoteReference") {
        this.drop("endnote")
        removeNode(c)
      } else if (c.localName === "commentReference") removeNode(c)
    }
  }

  // ── drawing / pict / object ──

  /** Kiểm đơn vị đồ hoạ: còn hợp lệ (ảnh nhúng) ⇒ ghi lại `r:*`; không ⇒ bỏ trọn đơn vị. */
  private async unit(el: Element, owner: Owner): Promise<void> {
    const all = [el, ...descendants(el)]
    if (el.localName === "object" || all.some((n) => ["OLEObject", "oleObj", "control"].includes(n.localName))) return this.dropUnit(el, "ole")

    const rels = await this.srcRels(owner.srcPart)
    const images: Array<{ node: Element; attr: Attr; srcPart: string; ext: string }> = []
    for (const n of all) {
      for (const a of rAttrs(n)) {
        const rel = rels.find((r) => r.id === a.value)
        if (n.localName === "hlinkClick" || n.localName === "hlinkHover") {
          if (rel && rel.type === RT.hyperlink && rel.targetMode === "External" && HTTP.test(rel.target)) {
            this.registerRel(owner, RT.hyperlink, rel.target, true, (newId) => n.setAttributeNS(R, a.name, newId))
            this.claim(n, a)
          } else {
            this.drop("external_link", rel?.target)
            removeNode(n)
          }
          continue
        }
        if (!rel) return this.dropUnit(el, "missing_relationship", a.value)
        if (rel.type !== RT.image) return this.dropUnit(el, "unsupported_part", rel.type.slice(rel.type.lastIndexOf("/") + 1))
        if (rel.targetMode === "External" || a.localName === "link") return this.dropUnit(el, "external_image", rel.target)
        const srcPart = await this.env.source.resolveRelationship(owner.srcPart, rel.id)
        const ext = srcPart?.slice(srcPart.lastIndexOf(".") + 1).toLowerCase() ?? ""
        if (!srcPart || !IMAGE_TYPES[ext]) return this.dropUnit(el, "unsupported_image", srcPart ?? rel.target)
        images.push({ node: n, attr: a, srcPart, ext })
      }
    }
    for (const img of images) {
      if (!(await this.ensureMedia(img.srcPart, img.ext))) return this.dropUnit(el, "unsupported_image", img.srcPart)
    }
    for (const img of images) {
      const name = this.env.committed.media.get(img.srcPart) ?? this.pending.media.get(img.srcPart)!.name
      this.registerRel(owner, RT.image, name.slice("word/".length), false, (newId) => img.node.setAttributeNS(R, img.attr.name, newId))
      this.claim(img.node, img.attr)
    }
    for (const n of all) if (n.localName === "docPr") n.setAttribute("id", String(++this.env.counters.docPr))
    // Textbox: đoạn bên trong cũng phải qua chuẩn hoá style / run
    for (const tb of all.filter((n) => n.localName === "txbxContent")) await this.blocks(tb, owner)
  }

  private dropUnit(el: Element, kind: DroppedKind, detail?: string): void {
    this.drop(kind, detail)
    removeNode(outermostUnit(el))
  }

  /** Đọc bytes ảnh nguồn và đặt tên part mới ở gói đích; `false` nếu không đọc được. */
  private async ensureMedia(srcPart: string, ext: string): Promise<boolean> {
    if (this.env.committed.media.has(srcPart) || this.pending.media.has(srcPart)) return true
    const data = await this.env.source.binary(srcPart)
    if (!data) return false
    let name: string
    do name = `word/media/transplant${++this.env.counters.media}.${ext}`
    while (this.env.target.has(name))
    this.pending.media.set(srcPart, { name, data, contentType: IMAGE_TYPES[ext] })
    return true
  }

  // ── footnote ──

  private async footnote(ref: Element): Promise<void> {
    const srcId = wAttr(ref, "id")
    const known = srcId ? this.pending.footnoteMap.get(srcId) : undefined
    if (known) return void ref.setAttributeNS(NS.w, "w:id", known)
    const part = await this.srcPart(RT.footnotes, PART.footnotes)
    const src = srcId && part ? wAll(part.doc, "footnote").find((f) => wAttr(f, "id") === srcId && !wAttr(f, "type")) : undefined
    if (!srcId || !part || !src) {
      this.drop("footnote_missing", srcId ?? undefined)
      return removeNode(ref)
    }
    const copy = this.doc.importNode(src, true) as Element
    const newId = String(++this.env.counters.footnote)
    copy.setAttributeNS(NS.w, "w:id", newId)
    normalize(copy)
    this.checkFields(copy)
    await this.blocks(copy, { srcPart: part.name, tgtPart: this.env.footnotesTarget })
    this.sweep(copy)
    this.bookmarks(copy)
    this.pending.footnoteMap.set(srcId, newId)
    this.pending.footnotes.push(copy)
    ref.setAttributeNS(NS.w, "w:id", newId)
  }

  // ── numbering ──

  private async mapNumId(srcNumId: string): Promise<string | null> {
    const known = this.env.committed.numMap.get(srcNumId) ?? this.pending.numMap.get(srcNumId)
    if (known) return known
    const part = await this.srcPart(RT.numbering, PART.numbering)
    const num = part ? wAll(part.doc, "num").find((n) => wAttr(n, "numId") === srcNumId) : undefined
    const absId = num ? wAttr(wKid(num, "abstractNumId"), "val") : null
    const abs = part && absId !== null ? wAll(part.doc, "abstractNum").find((a) => wAttr(a, "abstractNumId") === absId) : undefined
    if (!num || !abs || absId === null) {
      this.pending.warnings.add(`numId ${srcNumId} không có trong numbering của file nguồn, bỏ đánh số`)
      return null
    }
    let newAbs = this.env.committed.absMap.get(absId) ?? this.pending.absMap.get(absId)
    if (!newAbs) {
      if (wKid(abs, "numStyleLink") && !wKid(abs, "lvl")) throw new SectionError("unsupported_numbering", "Danh sách liên kết style (numStyleLink) chưa chép được")
      newAbs = String(++this.env.counters.abstractNum)
      const copy = this.doc.importNode(abs, true) as Element
      copy.setAttributeNS(NS.w, "w:abstractNumId", newAbs)
      // nsid / tmpl / liên kết style là của file nguồn
      for (const k of wKids(copy)) if (["nsid", "tmpl", "styleLink", "numStyleLink"].includes(k.localName)) removeNode(k)
      for (const lvl of wKids(copy, "lvl")) for (const k of wKids(lvl)) if (k.localName === "pStyle" || k.localName === "lvlPicBulletId") removeNode(k)
      this.pending.abstractNums.push(copy)
      this.pending.absMap.set(absId, newAbs)
    }
    const newNum = String(++this.env.counters.num)
    const copy = this.doc.importNode(num, true) as Element
    copy.setAttributeNS(NS.w, "w:numId", newNum)
    wKid(copy, "abstractNumId")!.setAttributeNS(NS.w, "w:val", newAbs)
    this.pending.nums.push(copy)
    this.pending.numMap.set(srcNumId, newNum)
    return newNum
  }

  // ── bookmark ──

  /** Đổi id mọi bookmark, đổi tên nếu trùng (kèm neo `w:anchor` / field REF); bỏ neo nội bộ `_ff_*` và bookmarkEnd mồ côi. */
  private bookmarks(holder: Element): void {
    const idMap = new Map<string, string>()
    const used = (name: string) => this.env.committed.bookmarks.has(name) || this.pending.bookmarks.has(name)
    for (const b of wAll(holder, "bookmarkStart")) {
      const name = wAttr(b, "name") ?? ""
      if (!name || name.startsWith(BLOCK_BOOKMARK_PREFIX) || name.startsWith(TABLE_BOOKMARK_PREFIX)) {
        removeNode(b)
        continue
      }
      let next = name
      for (let k = 2; used(next); k++) next = `${name.slice(0, 40 - String(k).length - 1)}_${k}`
      if (next !== name) {
        this.renames.set(name, next)
        b.setAttributeNS(NS.w, "w:name", next)
      }
      this.pending.bookmarks.add(next)
      const newId = String(++this.env.counters.annotation)
      idMap.set(wAttr(b, "id") ?? "", newId)
      b.setAttributeNS(NS.w, "w:id", newId)
    }
    for (const e of wAll(holder, "bookmarkEnd")) {
      const id = idMap.get(wAttr(e, "id") ?? "")
      if (id === undefined) removeNode(e)
      else e.setAttributeNS(NS.w, "w:id", id)
    }
    if (!this.renames.size) return
    // Chỉ đổi đối số tên bookmark của REF / PAGEREF / NOTEREF và `HYPERLINK \l` — không đụng chữ khác (vd đường dẫn URL)
    const swap = (text: string): string => {
      const ref = /^(\s*(?:REF|PAGEREF|NOTEREF)\s+)("?)([^\s"\\]+)\2/i.exec(text)
      if (ref && this.renames.has(ref[3])) return text.replace(ref[0], `${ref[1]}${ref[2]}${this.renames.get(ref[3])}${ref[2]}`)
      if (!/^\s*HYPERLINK\b/i.test(text)) return text
      return text.replace(/(\\l\s+)("?)([^\s"]+)\2/i, (whole, sw: string, q: string, name: string) => (this.renames.has(name) ? `${sw}${q}${this.renames.get(name)}${q}` : whole))
    }
    for (const h of wAll(holder, "hyperlink")) {
      const a = wAttr(h, "anchor")
      if (a && this.renames.has(a)) h.setAttributeNS(NS.w, "w:anchor", this.renames.get(a)!)
    }
    for (const t of wAll(holder, "instrText")) t.textContent = swap(t.textContent ?? "")
    for (const f of wAll(holder, "fldSimple")) f.setAttributeNS(NS.w, "w:instr", swap(wAttr(f, "instr") ?? ""))
  }

  /** Bỏ định danh đoạn của file nguồn (trùng paraId làm Word phàn nàn). */
  private finalize(holder: Element): void {
    for (const el of [holder, ...descendants(holder), ...this.pending.footnotes.flatMap((f) => [f, ...descendants(f)])])
      for (const a of Array.from(el.attributes)) if (a.namespaceURI === NS.w14 && (a.localName === "paraId" || a.localName === "textId")) el.removeAttributeNode(a)
  }
}

// ─── ghi vào gói đích ───────────────────────────────────────────

const ensurePart = async (pkg: DocxPackage, type: string, existing: string | null, fallback: string, contentType: string, rootXml: string): Promise<Document> => {
  if (existing) return pkg.requireXml(existing)
  const doc = await pkg.addXmlPart(fallback, rootXml, contentType)
  await pkg.addRelationship(MAIN_PART, type, fallback.slice("word/".length))
  return doc
}

const FOOTNOTES_ROOT =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:footnotes xmlns:w="${NS.w}" xmlns:r="${NS.r}">` +
  `<w:footnote w:type="separator" w:id="-1"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:separator/></w:r></w:p></w:footnote>` +
  `<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:continuationSeparator/></w:r></w:p></w:footnote></w:footnotes>`

/** Con của `w:settings` đứng sau `w:footnotePr` theo thứ tự schema — `footnotePr` chèn trước phần tử đầu tiên trong số này. */
const AFTER_FOOTNOTE_PR = ["endnotePr", "compat", "docVars", "rsids", "mathPr", "attachedSchema", "themeFontLang", "clrSchemeMapping", "doNotIncludeSubdocsInStats", "doNotAutoCompressPictures", "forceUpgrade", "captions", "readModeInkLockDown", "smartTagType", "schemaLibrary", "shapeDefaults", "doNotEmbedSmartTags", "decimalSymbol", "listSeparator"]

/**
 * Part footnotes vừa tạo mới: khai báo hai footnote phân cách (-1 / 0) trong `settings.xml` bằng `w:footnotePr` để Word nhận ra.
 * Đích không có settings.xml thì bỏ qua (Word vẫn mở được, chỉ thiếu khai báo).
 */
const declareFootnoteSeparators = async (pkg: DocxPackage): Promise<void> => {
  const doc = await pkg.xml("word/settings.xml")
  if (!doc || wKid(doc.documentElement, "footnotePr")) return
  const pr = wEl(doc, "footnotePr")
  for (const id of ["-1", "0"]) pr.appendChild(wEl(doc, "footnote", { id }))
  const before = wKids(doc.documentElement).find((k) => AFTER_FOOTNOTE_PR.includes(k.localName))
  doc.documentElement.insertBefore(pr, before ?? null)
}

/** Con của `w:settings` đứng sau `w:updateFields` theo thứ tự schema. */
const AFTER_UPDATE_FIELDS = ["hdrShapeDefaults", "footnotePr", ...AFTER_FOOTNOTE_PR]

/**
 * File nền dựng từ file mẫu mang theo mục lục (và field khác) đã tính sẵn của **file mẫu** — mục lục in ra là mục lục cũ của mẫu
 * ("<<Feature Name 1>>", "Error! Bookmark not defined."). Đánh dấu field TOC `w:dirty` và bật `w:updateFields` để Word dựng lại khi
 * mở (cùng cách bản xuất thường của `docx-writer`). Không có settings.xml ⇒ chỉ đánh dấu field.
 */
export const requestFieldUpdate = async (pkg: DocxPackage): Promise<{ tocFields: number }> => {
  let tocFields = 0
  const doc = await pkg.xml(MAIN_PART)
  if (doc) {
    for (const simple of wAll(doc, "fldSimple")) {
      if (!/^\s*TOC\b/.test(wAttr(simple, "instr") ?? "")) continue
      simple.setAttributeNS(NS.w, "w:dirty", "true")
      tocFields++
    }
    // Field phức: begin … instrText … separate … end, lồng nhau được (PAGEREF / HYPERLINK trong từng dòng mục lục)
    const stack: { begin: Element; instr: string }[] = []
    for (const run of wAll(doc, "r")) {
      for (const el of wKids(run)) {
        if (el.localName === "fldChar") {
          const type = wAttr(el, "fldCharType")
          if (type === "begin") stack.push({ begin: el, instr: "" })
          else if (type === "end") {
            const field = stack.pop()
            if (field && /^\s*TOC\b/.test(field.instr)) {
              field.begin.setAttributeNS(NS.w, "w:dirty", "true")
              tocFields++
            }
          }
        } else if (el.localName === "instrText" && stack.length) stack[stack.length - 1].instr += el.textContent ?? ""
      }
    }
  }
  const settings = await pkg.xml("word/settings.xml")
  if (settings && !wKid(settings.documentElement, "updateFields")) {
    const before = wKids(settings.documentElement).find((k) => AFTER_UPDATE_FIELDS.includes(k.localName))
    settings.documentElement.insertBefore(wEl(settings, "updateFields", { val: "true" }), before ?? null)
  }
  return { tocFields }
}

/** Khai báo namespace của gốc nguồn mà gốc đích chưa có (nội dung chép sang có thể dùng w14 / wp14…); prefix `mc:Ignorable` đi kèm. */
const mergeNamespaces = (srcRoot: Element, tgtRoot: Element): void => {
  const ignorable = new Set((tgtRoot.getAttribute("mc:Ignorable") ?? "").split(/\s+/).filter(Boolean))
  const srcIgnorable = new Set((srcRoot.getAttribute("mc:Ignorable") ?? "").split(/\s+/).filter(Boolean))
  let changed = false
  for (const a of Array.from(srcRoot.attributes)) {
    if (!a.name.startsWith("xmlns:") || tgtRoot.hasAttribute(a.name)) continue
    tgtRoot.setAttributeNS("http://www.w3.org/2000/xmlns/", a.name, a.value)
    const prefix = a.name.slice("xmlns:".length)
    if (srcIgnorable.has(prefix) && tgtRoot.hasAttribute("mc:Ignorable")) {
      ignorable.add(prefix)
      changed = true
    }
  }
  if (changed) tgtRoot.setAttribute("mc:Ignorable", [...ignorable].join(" "))
}

const commit = async (env: Env, b: SectionBuilder, nodes: Element[], after: Element): Promise<void> => {
  const { target } = env
  const p = b.pending
  for (const [srcPart, m] of p.media) {
    await target.addBinaryPart(m.name, m.data, m.contentType)
    env.committed.media.set(srcPart, m.name)
  }
  // Rels trước: setter gán r:id vào nút nháp, các nút này được nhân bản sang part đích ở bước sau
  for (const [key, rel] of p.rels) {
    const rid = await target.addRelationship(rel.owner, rel.type, rel.target, rel.external ? { targetMode: "External" } : {})
    env.committed.rels.set(key, rid)
    for (const set of rel.setters) set(rid)
  }
  if (p.footnotes.length) {
    const existingFootnotes = await partOfType(target, RT.footnotes, PART.footnotes)
    const doc = await ensurePart(target, RT.footnotes, existingFootnotes, PART.footnotes, CT.footnotes, FOOTNOTES_ROOT)
    if (!existingFootnotes) await declareFootnoteSeparators(target)
    for (const f of p.footnotes) doc.documentElement.appendChild(doc.importNode(f, true))
  }
  if (p.abstractNums.length || p.nums.length) {
    const doc = await ensurePart(target, RT.numbering, await partOfType(target, RT.numbering, PART.numbering), PART.numbering, CT.numbering, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="${NS.w}"/>`)
    const root = doc.documentElement
    const cleanup = wKid(root, "numIdMacAtCleanup") ?? null
    const firstNum = wKid(root, "num") ?? cleanup
    for (const a of p.abstractNums) root.insertBefore(doc.importNode(a, true), firstNum)
    for (const n of p.nums) root.insertBefore(doc.importNode(n, true), cleanup)
  }
  for (const [k, v] of p.numMap) env.committed.numMap.set(k, v)
  for (const [k, v] of p.absMap) env.committed.absMap.set(k, v)
  for (const name of p.bookmarks) env.committed.bookmarks.add(name)
  mergeNamespaces(env.srcDoc.documentElement, env.targetDoc.documentElement)
  let cursor: Node = after
  for (const n of nodes) {
    insertAfter(n, cursor)
    cursor = n
  }
}

export interface Transplanter {
  /** Chép một mục; mục lỗi ⇒ `ok: false` + `error`, không nối gì vào DOM của đích. */
  run(request: TransplantRequest): Promise<TransplantResult>
}

/**
 * Bộ chép dùng chung một môi trường cho mọi mục của một lượt dựng: cùng `numId` nguồn ⇒ cùng `numId` đích (đánh số liên tục), ảnh
 * / rels không nhân bản, bộ đếm id (bookmark, footnote, docPr, numbering) liên tục. Lỗi hạ tầng của chính gói (không đọc được
 * `document.xml`…) vẫn ném.
 */
export const createTransplanter = async (source: DocxPackage, target: DocxPackage): Promise<Transplanter> => {
  const env = await createEnv(source, target)
  return {
    run: async (req) => {
      const fail = (code: TransplantErrorCode, message: string, b?: SectionBuilder): TransplantResult => ({
        key: req.key,
        ok: false,
        inserted: [],
        dropped: b?.pending.dropped ?? [],
        warnings: [...(b?.pending.warnings ?? [])],
        error: { code, message }
      })
      if (!req.after.parentNode || req.elements.some((e) => e.ownerDocument !== env.srcDoc)) {
        return fail("invalid_input", "`after` không nằm trong đích hoặc `elements` không thuộc document.xml nguồn")
      }
      const builder = new SectionBuilder(env, req.headingShift ?? 0)
      try {
        const nodes = await builder.build(req.elements)
        await commit(env, builder, nodes, req.after)
        return { key: req.key, ok: true, inserted: nodes, dropped: builder.pending.dropped, warnings: [...builder.pending.warnings] }
      } catch (err) {
        return err instanceof SectionError ? fail(err.code, err.message, builder) : fail("unexpected", err instanceof Error ? err.message : String(err), builder)
      }
    }
  }
}

/** Chép các khối của từng mục từ `source` sang `target` (một môi trường chung cho cả lượt). */
export const transplantSections = async (source: DocxPackage, target: DocxPackage, requests: readonly TransplantRequest[]): Promise<TransplantResult[]> => {
  const transplanter = await createTransplanter(source, target)
  const results: TransplantResult[] = []
  for (const req of requests) results.push(await transplanter.run(req))
  return results
}

// ─── allow-list rels cho cả gói ─────────────────────────────────

const relsOwner = (relsPath: string): string => {
  const m = /^(.*)_rels\/(.*)\.rels$/.exec(relsPath)
  return m ? `${m[1]}${m[2]}` : ""
}

const kindOfRel = (type: string, external: boolean): DroppedKind => {
  if (/oleObject$|\/package$/.test(type)) return "ole"
  if (/aFChunk$/.test(type)) return "alt_chunk"
  if (/subDocument$/.test(type)) return "sub_document"
  if (/attachedTemplate$/.test(type)) return "attached_template"
  if (type === RT.image && external) return "external_image"
  return "external_link"
}

/** Phần tử còn trỏ tới rels đã bị gỡ: bỏ đơn vị / bóc link / bỏ phần tử. */
const dropDanglingRefs = (doc: Document, ids: ReadonlySet<string>): void => {
  for (const el of descendants(doc.documentElement)) {
    const refs = rAttrs(el).some((a) => ids.has(a.value))
    if (!refs) continue
    if (el.namespaceURI === NS.w && el.localName === "hyperlink") unwrap(el)
    else if (el.localName === "hlinkClick" || el.localName === "hlinkHover" || ["attachedTemplate", "altChunk", "subDoc"].includes(el.localName)) removeNode(el)
    else removeNode(outermostUnit(el))
  }
}

/**
 * Ép allow-list rels lên cả gói (dùng cho file nền kết quả): gỡ OLE / package / subDocument / altChunk / attachedTemplate / frame
 * và mọi quan hệ ngoài gói không phải hyperlink `http(s)` (ảnh ngoài, UNC, `file:`, `mailto:`…), rồi bỏ phần tử còn trỏ tới chúng.
 */
export const enforceRelsAllowList = async (pkg: DocxPackage): Promise<DroppedItem[]> => {
  const dropped: DroppedItem[] = []
  for (const relsPath of pkg.partNames().filter((n) => n.endsWith(".rels"))) {
    const rels = await pkg.xml(relsPath)
    if (!rels) continue
    const removed = new Set<string>()
    for (const rel of Array.from(rels.getElementsByTagNameNS(NS.rels, "Relationship"))) {
      const type = rel.getAttribute("Type") ?? ""
      const target = rel.getAttribute("Target") ?? ""
      const external = rel.getAttribute("TargetMode") === "External"
      if (DANGEROUS_REL.test(type) || (external && !(type === RT.hyperlink && HTTP.test(target)))) {
        removed.add(rel.getAttribute("Id") ?? "")
        dropped.push({ kind: kindOfRel(type, external), detail: target })
        removeNode(rel)
      }
    }
    const owner = relsOwner(relsPath)
    const ownerDoc = removed.size && owner ? await pkg.xml(owner) : null
    if (ownerDoc) dropDanglingRefs(ownerDoc, removed)
  }
  return dropped
}

// ─── kiểm cấu trúc ──────────────────────────────────────────────

/**
 * Kiểm cấu trúc gói theo những điều Word đòi để mở được (không thay cho mở thật bằng Word): mọi part XML đúng cú pháp, content
 * type đủ, rels trỏ part có thật, mọi `r:*` giải được, numId / footnote id có định nghĩa, bookmark không trùng id / tên.
 * Trả danh sách vấn đề (rỗng = ổn).
 */
export const validateDocxStructure = async (pkg: DocxPackage): Promise<string[]> => {
  const problems: string[] = []
  const docs = new Map<string, Document>()
  for (const name of pkg.partNames().filter((n) => /\.(xml|rels)$/i.test(n))) {
    try {
      const d = await pkg.xml(name)
      if (d) docs.set(name, d)
    } catch (err) {
      problems.push(`XML hỏng: ${name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const ct = docs.get("[Content_Types].xml")
  if (!ct) problems.push("Thiếu [Content_Types].xml")
  else {
    const defaults = new Set(Array.from(ct.getElementsByTagNameNS(NS.ct, "Default")).map((d) => (d.getAttribute("Extension") ?? "").toLowerCase()))
    const overrides = new Set(Array.from(ct.getElementsByTagNameNS(NS.ct, "Override")).map((o) => o.getAttribute("PartName") ?? ""))
    for (const name of pkg.partNames()) {
      if (name === "[Content_Types].xml") continue
      if (!defaults.has(name.slice(name.lastIndexOf(".") + 1).toLowerCase()) && !overrides.has(`/${name}`)) problems.push(`Thiếu content type: ${name}`)
    }
  }
  for (const [name, doc] of docs) {
    if (name.endsWith(".rels")) {
      const owner = relsOwner(name)
      const seen = new Set<string>()
      for (const rel of await pkg.relationships(owner)) {
        if (seen.has(rel.id)) problems.push(`${name}: trùng Id ${rel.id}`)
        seen.add(rel.id)
        if (rel.targetMode === "External") continue
        const part = await pkg.resolveRelationship(owner, rel.id)
        if (!part || !pkg.has(part)) problems.push(`${name}: ${rel.id} trỏ part không có (${rel.target})`)
      }
      continue
    }
    if (name === "[Content_Types].xml") continue
    const ids = new Set((await pkg.relationships(name)).map((r) => r.id))
    for (const el of descendants(doc.documentElement))
      for (const a of rAttrs(el)) if (!ids.has(a.value)) problems.push(`${name}: ${el.localName}@${a.name}="${a.value}" không có trong rels`)
  }
  const main = docs.get(MAIN_PART)
  const numbering = docs.get(PART.numbering)
  const footnotes = docs.get(PART.footnotes)
  const nums = new Set(numbering ? wAll(numbering, "num").map((n) => wAttr(n, "numId") ?? "") : [])
  const abstracts = new Set(numbering ? wAll(numbering, "abstractNum").map((n) => wAttr(n, "abstractNumId") ?? "") : [])
  for (const d of [main, footnotes]) {
    if (!d) continue
    for (const n of wAll(d, "numPr").flatMap((x) => wKids(x, "numId"))) {
      const v = wAttr(n, "val") ?? ""
      if (v !== "0" && !nums.has(v)) problems.push(`numId ${v} không có trong numbering.xml`)
    }
  }
  if (numbering) for (const n of wAll(numbering, "num")) if (!abstracts.has(wAttr(wKid(n, "abstractNumId"), "val") ?? "")) problems.push(`num ${wAttr(n, "numId")} trỏ abstractNum không có`)
  if (main) {
    const fnIds = new Set(footnotes ? wAll(footnotes, "footnote").map((f) => wAttr(f, "id") ?? "") : [])
    for (const r of wAll(main, "footnoteReference")) if (!fnIds.has(wAttr(r, "id") ?? "")) problems.push(`footnoteReference ${wAttr(r, "id")} không có trong footnotes.xml`)
    const ids = new Set<string>()
    const names = new Set<string>()
    for (const b of wAll(main, "bookmarkStart")) {
      const id = wAttr(b, "id") ?? ""
      const name = wAttr(b, "name") ?? ""
      if (ids.has(id)) problems.push(`Trùng id bookmark ${id}`)
      if (names.has(name)) problems.push(`Trùng tên bookmark ${name}`)
      ids.add(id)
      names.add(name)
    }
  }
  return problems
}

// ─── dọn part mồ côi ─────────────────────────────────────────────

/**
 * Dọn phần thừa sau khi dựng file nền: (1) quan hệ ảnh / hyperlink do lượt chép tạo (`rIdFF*`) mà không còn `r:*` nào trỏ tới
 * (mục lỗi giữa chừng, nút bị bỏ); (2) mọi part không còn tới được từ gốc gói qua rels — gồm `embeddings/*.bin`, `vbaProject.bin`
 * của quan hệ đã gỡ — cùng `Override` của chúng. Trả tên part đã xoá.
 */
export const pruneUnreferencedParts = async (pkg: DocxPackage): Promise<string[]> => {
  for (const relsPath of pkg.partNames().filter((n) => n.endsWith(".rels"))) {
    const owner = relsOwner(relsPath)
    if (!owner.endsWith(".xml")) continue
    const ownerDoc = await pkg.xml(owner)
    const rels = await pkg.xml(relsPath)
    if (!ownerDoc || !rels) continue
    const used = new Set<string>()
    for (const el of descendants(ownerDoc.documentElement)) for (const a of rAttrs(el)) used.add(a.value)
    for (const rel of Array.from(rels.getElementsByTagNameNS(NS.rels, "Relationship"))) {
      const type = rel.getAttribute("Type") ?? ""
      const id = rel.getAttribute("Id") ?? ""
      if (id.startsWith("rIdFF") && (type === RT.image || type === RT.hyperlink) && !used.has(id)) removeNode(rel)
    }
  }

  const reachable = new Set<string>(["[Content_Types].xml"])
  const queue = [""]
  const seen = new Set<string>([""])
  while (queue.length) {
    const owner = queue.pop()!
    reachable.add(relsPathOf(owner))
    for (const rel of await pkg.relationships(owner)) {
      if (rel.targetMode === "External") continue
      const part = await pkg.resolveRelationship(owner, rel.id)
      if (!part || !pkg.has(part) || seen.has(part)) continue
      seen.add(part)
      reachable.add(part)
      queue.push(part)
    }
  }
  const removed = pkg.partNames().filter((n) => !reachable.has(n))
  for (const name of removed) pkg.removePart(name)
  if (removed.length) {
    const ct = await pkg.xml("[Content_Types].xml")
    if (ct) for (const o of Array.from(ct.getElementsByTagNameNS(NS.ct, "Override"))) if (!pkg.has((o.getAttribute("PartName") ?? "").replace(/^\//, ""))) removeNode(o)
  }
  return removed
}
