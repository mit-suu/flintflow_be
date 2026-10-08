/**
 * Bản tải "có đánh dấu" của version minor do CR ghi — BPMN 3.14 "Track Changes cho group được duyệt, tác giả = CR id"
 * (mode 1 v3, nợ T6 + T7).
 * Tài liệu render lại từ Spine (D1) nên không có file gốc để ghi Track Changes lên: so **từng đoạn** của bản render trước
 * với bản render mới (khớp LCS theo text; đoạn lẻ giữa hai đoạn đã khớp, giống từ ≥ `MODIFIED_SIMILARITY` ⇒ sửa), rồi
 * ghi khác biệt vào bản mới dưới dạng `w:ins` / `w:del`. Ghi chú của CR (vị trí kết luận `comment`) thành comment Word ở
 * tiêu đề mục của vị trí. File lưu riêng, không thay bản sạch; release (6.2) không bao giờ mang đánh dấu.
 */

import { DocxPackage, MAIN_PART, RevisionIds, addComment, applyEdit, normalizeText, readBlocks, tokenize, type OoxmlBlock } from "../docx-ooxml/index.js"
import { isW, wEl, wKid, wKids, wText } from "../docx-ooxml/xml.js"

/** Cặp đoạn lẻ giống nhau từ tỉ lệ này trở lên ⇒ một đoạn bị sửa; thấp hơn ⇒ xoá đoạn cũ + thêm đoạn mới. */
export const MODIFIED_SIMILARITY = 0.5

export interface ParagraphChange {
  kind: "modified" | "added" | "removed"
  before: string
  after: string
  /** `modified` / `added`: chỉ số đoạn trong bản mới. `removed`: chèn đoạn đã xoá **trước** đoạn này (= số đoạn ⇒ cuối). */
  next_index: number
}

export interface TrackedComment {
  section_title: string
  text: string
}

const words = (s: string): string[] => tokenize(s).filter((t) => !/^\s+$/.test(t))

/** Tỉ lệ từ chung (Dice) giữa hai đoạn. */
export const similarity = (a: string, b: string): number => {
  const wa = words(a)
  const wb = words(b)
  if (!wa.length && !wb.length) return 1
  const pool = new Map<string, number>()
  for (const w of wa) pool.set(w, (pool.get(w) ?? 0) + 1)
  let common = 0
  for (const w of wb) {
    const n = pool.get(w) ?? 0
    if (n > 0) {
      common++
      pool.set(w, n - 1)
    }
  }
  return (2 * common) / (wa.length + wb.length)
}

const lcsPairs = (a: string[], b: string[]): [number, number][] => {
  const n = a.length
  const m = b.length
  if (!n || !m) return []
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out: [number, number][] = []
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (a[i] === b[j]) out.push([i++, j++])
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++
    else j++
  }
  return out
}

/**
 * Khác biệt theo đoạn giữa bản trước (`prev`) và bản mới (`next`) — hàm thuần. Cắt phần đầu/cuối trùng trước (hai
 * version liền nhau thường chỉ khác vài đoạn) rồi LCS phần giữa.
 */
export const pairParagraphs = (prev: readonly string[], next: readonly string[]): ParagraphChange[] => {
  const a = prev.map(normalizeText)
  const b = next.map(normalizeText)
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  const anchors = lcsPairs(a.slice(pre, a.length - suf), b.slice(pre, b.length - suf)).map(([i, j]) => [i + pre, j + pre] as const)
  anchors.push([a.length - suf, b.length - suf])

  const out: ParagraphChange[] = []
  let pi = pre
  let pj = pre
  for (const [ai, aj] of anchors) {
    const olds = prev.slice(pi, ai)
    const news = next.slice(pj, aj)
    const k = Math.min(olds.length, news.length)
    for (let x = 0; x < k; x++) {
      if (similarity(olds[x], news[x]) >= MODIFIED_SIMILARITY) out.push({ kind: "modified", before: olds[x], after: news[x], next_index: pj + x })
      else {
        out.push({ kind: "removed", before: olds[x], after: "", next_index: pj + x })
        out.push({ kind: "added", before: "", after: news[x], next_index: pj + x })
      }
    }
    for (let x = k; x < olds.length; x++) out.push({ kind: "removed", before: olds[x], after: "", next_index: aj })
    for (let x = k; x < news.length; x++) out.push({ kind: "added", before: "", after: news[x], next_index: pj + x })
    pi = ai + 1
    pj = aj + 1
  }
  return out
}

/** Thay nội dung đoạn bằng một run chữ (giữ `pPr`, bookmark và định dạng run đầu) — để `applyEdit` diff từ text đó. */
const setParagraphText = (p: Element, text: string): void => {
  const doc = p.ownerDocument
  const rPr = wKids(p, "r")
    .map((r) => wKid(r, "rPr"))
    .find(Boolean)
  for (const child of Array.from(p.childNodes)) {
    if (isW(child, "pPr") || isW(child, "bookmarkStart") || isW(child, "bookmarkEnd")) continue
    p.removeChild(child)
  }
  if (!text) return
  const r = wEl(doc, "r")
  if (rPr) r.appendChild(rPr.cloneNode(true))
  r.appendChild(wText(doc, "t", text))
  p.appendChild(r)
}

/** Đoạn rỗng mới cùng định dạng đoạn với `like` (để chứa phần bị xoá). */
const paragraphLike = (like: Element): Element => {
  const p = wEl(like.ownerDocument, "p")
  const pPr = wKid(like, "pPr")
  if (pPr) p.appendChild(pPr.cloneNode(true))
  return p
}

const isParagraph = (b: OoxmlBlock): boolean => b.kind !== "table" && isW(b.element, "p")

export interface TrackedResult {
  data: Buffer
  /** Số đoạn được đánh dấu. */
  changes: number
  /** Đoạn đổi nhưng không đánh dấu được (ảnh, field, textbox…) — giữ nguyên nội dung mới, không đánh dấu. */
  skipped: number
}

/**
 * Ghi khác biệt bản `prevFile` → `nextFile` vào `nextFile` dạng Track Changes (tác giả `who.author`), gắn `comments` ở
 * tiêu đề mục. Không đổi nội dung cuối của bản mới: accept-all ra đúng bản render mới.
 */
export const buildTrackedDocx = async (prevFile: Buffer, nextFile: Buffer, who: { author: string; date: Date }, comments: readonly TrackedComment[] = []): Promise<TrackedResult> => {
  const prev = (await readBlocks(await DocxPackage.load(prevFile))).filter(isParagraph)
  const pkg = await DocxPackage.load(nextFile)
  const next = (await readBlocks(pkg)).filter(isParagraph)
  const author = { author: who.author, date: who.date, ids: new RevisionIds(await pkg.requireXml(MAIN_PART)) }

  let changes = 0
  let skipped = 0
  for (const ch of pairParagraphs(
    prev.map((b) => b.text),
    next.map((b) => b.text)
  )) {
    if (ch.kind === "removed") {
      const anchor = next[ch.next_index]?.element ?? next[next.length - 1]?.element
      if (!anchor?.parentNode) {
        skipped++
        continue
      }
      const p = paragraphLike(anchor)
      if (next[ch.next_index]) anchor.parentNode.insertBefore(p, anchor)
      else anchor.parentNode.insertBefore(p, anchor.nextSibling)
      setParagraphText(p, ch.before)
      applyEdit(p, ch.before, "", author)
      changes++
      continue
    }
    const block = next[ch.next_index]
    if (!block?.editable) {
      skipped++
      continue
    }
    setParagraphText(block.element, ch.before)
    applyEdit(block.element, ch.before, ch.after, author)
    changes++
  }

  for (const c of comments) {
    const title = normalizeText(c.section_title).toLowerCase()
    const target = (title && next.find((b) => b.kind === "heading" && normalizeText(b.text).toLowerCase().includes(title))) || next[0]
    if (!target) continue
    await addComment(pkg, target.element, c.text, { author: who.author, date: who.date, initials: "CR" })
  }
  return { data: await pkg.toBuffer(), changes, skipped }
}
