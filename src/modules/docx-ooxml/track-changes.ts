/**
 * Ghi sửa đổi dạng Track Changes vào một đoạn (C-7, nút 3.14). FLF-171, plan §6 2A.
 * Diff theo từ (LCS trên token chữ/số, khoảng trắng, dấu câu), chỉ bọc phần đổi bằng `w:del` / `w:ins`,
 * `w:ins` mang `rPr` của run gốc. Chạy được trên đoạn văn, ô bảng, list item và đoạn đã có Track Changes
 * của CR trước (run trong `w:ins` cũ bị xoá ⇒ `w:del` lồng trong `w:ins`, như Word ghi).
 */

import { normalizeText, paragraphText, runChildText, visibleRuns } from "./text.js"
import { OoxmlError, insertAfter, isW, maxWId, removeNode, wEl, wKid, wText } from "./xml.js"

/** Mọi phần tử mang `w:id` thuộc nhóm chú thích/revision — cấp id mới lớn hơn tất cả để không trùng. */
const ANNOTATION_ELEMENTS = [
  "ins",
  "del",
  "moveFrom",
  "moveTo",
  "rPrChange",
  "pPrChange",
  "sectPrChange",
  "tblPrChange",
  "trPrChange",
  "tcPrChange",
  "numberingChange",
  "bookmarkStart",
  "commentRangeStart",
  "moveFromRangeStart",
  "moveToRangeStart"
] as const

/** Bộ cấp `w:id` cho revision trong một part. */
export class RevisionIds {
  private next: number

  constructor(doc: Document) {
    this.next = maxWId(doc, ANNOTATION_ELEMENTS) + 1
  }

  take(): string {
    return String(this.next++)
  }
}

/** `w:date` theo ISO không có phần nghìn giây (Word ghi dạng này). */
export const toWDate = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, "Z")

export interface RevisionAuthor {
  author: string
  date: Date
  ids: RevisionIds
}

export interface EditHunk {
  /** Vị trí trong text cũ `[start, end)`. */
  start: number
  end: number
  deleted: string
  inserted: string
}

// ---------------------------------------------------------------------------------------------
// Diff theo từ

const TOKEN = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu
export const tokenize = (s: string): string[] => s.match(TOKEN) ?? []

const sameToken = (a: string, b: string): boolean => a === b || (/^\s+$/.test(a) && /^\s+$/.test(b))

/** Trần DP; quá thì chỉ tách tiền tố/hậu tố chung (một hunk). */
const MAX_LCS_CELLS = 4_000_000

/** Hunk tối thiểu để biến `oldText` thành `newText` (theo token). */
export const diffWords = (oldText: string, newText: string): EditHunk[] => {
  const a = tokenize(oldText)
  const b = tokenize(newText)
  let pre = 0
  while (pre < a.length && pre < b.length && sameToken(a[pre], b[pre])) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && sameToken(a[a.length - 1 - suf], b[b.length - 1 - suf])) suf++
  const aMid = a.slice(pre, a.length - suf)
  const bMid = b.slice(pre, b.length - suf)
  const offsetOf = (tokens: string[], upto: number): number => tokens.slice(0, upto).join("").length

  // ops trên phần giữa: "=" giữ, "-" xoá token a, "+" thêm token b
  const ops: ("=" | "-" | "+")[] = []
  if (aMid.length * bMid.length > MAX_LCS_CELLS) {
    ops.push(...aMid.map(() => "-" as const), ...bMid.map(() => "+" as const))
  } else {
    const n = aMid.length
    const m = bMid.length
    const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        lcs[i][j] = sameToken(aMid[i], bMid[j]) ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    let i = 0
    let j = 0
    while (i < n || j < m) {
      if (i < n && j < m && sameToken(aMid[i], bMid[j])) {
        ops.push("=")
        i++
        j++
      } else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) {
        ops.push("+")
        j++
      } else {
        ops.push("-")
        i++
      }
    }
  }

  const hunks: EditHunk[] = []
  let ai = pre
  let bi = pre
  let cur: { aStart: number; aEnd: number; ins: string } | null = null
  const flush = (): void => {
    if (!cur) return
    const start = offsetOf(a, cur.aStart)
    const end = offsetOf(a, cur.aEnd)
    hunks.push({ start, end, deleted: oldText.slice(start, end), inserted: cur.ins })
    cur = null
  }
  for (const op of ops) {
    if (op === "=") {
      flush()
      ai++
      bi++
    } else if (op === "-") {
      cur ??= { aStart: ai, aEnd: ai, ins: "" }
      cur.aEnd = ++ai
    } else {
      cur ??= { aStart: ai, aEnd: ai, ins: "" }
      cur.ins += b[bi++]
    }
  }
  flush()
  return hunks
}

// ---------------------------------------------------------------------------------------------
// Thao tác run

interface RunSpan {
  r: Element
  start: number
  end: number
}

const runSpans = (p: Element): RunSpan[] => {
  let o = 0
  return visibleRuns(p).map((r) => {
    let len = 0
    for (let c = r.firstChild; c; c = c.nextSibling) len += (runChildText(c as Element) ?? "").length
    const span = { r, start: o, end: o + len }
    o += len
    return span
  })
}

/** Tách run tại `at` ký tự (0 < at < độ dài) ⇒ run thứ hai chèn ngay sau, cùng cha, cùng `rPr`. */
const splitRun = (r: Element, at: number): void => {
  const doc = r.ownerDocument
  let o = 0
  let boundary: Node | null = null
  for (let c = r.firstChild; c; c = c.nextSibling) {
    const t = runChildText(c as Element)
    if (t === null) continue
    if (o === at) {
      boundary = c
      break
    }
    if (at < o + t.length) {
      // chỉ w:t có độ dài > 1 ⇒ tách w:t
      const el = c as Element
      const left = wText(doc, "t", t.slice(0, at - o))
      const right = wText(doc, "t", t.slice(at - o))
      r.insertBefore(left, el)
      r.insertBefore(right, el)
      r.removeChild(el)
      boundary = right
      break
    }
    o += t.length
  }
  if (!boundary) return
  const r2 = r.cloneNode(false) as Element
  const rPr = wKid(r, "rPr")
  if (rPr) r2.appendChild(rPr.cloneNode(true))
  while (boundary) {
    const nextNode: Node | null = boundary.nextSibling
    r2.appendChild(boundary)
    boundary = nextNode
  }
  insertAfter(r2, r)
}

const splitAt = (p: Element, offset: number): void => {
  const span = runSpans(p).find((s) => s.start < offset && offset < s.end)
  if (span) splitRun(span.r, offset - span.start)
}

const toDeleted = (r: Element): void => {
  const doc = r.ownerDocument
  for (let c: Node | null = r.firstChild; c; ) {
    const nextNode: Node | null = c.nextSibling
    if (isW(c, "t")) {
      r.insertBefore(wText(doc, "delText", c.textContent ?? ""), c)
      r.removeChild(c)
    }
    c = nextNode
  }
}

const revisionEl = (doc: Document, local: "ins" | "del", who: RevisionAuthor): Element =>
  wEl(doc, local, { id: who.ids.take(), author: who.author, date: toWDate(who.date) })

const isRevisionContainer = (n: Node | null): n is Element => isW(n, "ins") || isW(n, "moveTo")

/**
 * Đặt `node` ngay sau (hoặc trước) `ref`, tách `w:ins`/`w:moveTo` đang bao `ref` để không lồng `w:ins` trong `w:ins`.
 */
const placeOutsideRevisions = (node: Element, ref: Node, where: "after" | "before", who: RevisionAuthor): void => {
  let cur: Node = ref
  const pos = where
  while (isRevisionContainer(cur.parentNode)) {
    const container = cur.parentNode
    const tail = container.cloneNode(false) as Element
    tail.setAttributeNS(container.namespaceURI, "w:id", who.ids.take())
    let move: Node | null = pos === "after" ? cur.nextSibling : cur
    while (move) {
      const nextNode: Node | null = move.nextSibling
      tail.appendChild(move)
      move = nextNode
    }
    if (tail.firstChild) insertAfter(tail, container)
    if (pos === "after") cur = container
    else {
      if (!container.firstChild) removeNode(container)
      cur = tail
    }
  }
  if (pos === "after") insertAfter(node, cur)
  else cur.parentNode!.insertBefore(node, cur)
}

const buildInsertedRun = (doc: Document, text: string, rPrFrom: Element | null): Element => {
  const r = wEl(doc, "r")
  const rPr = rPrFrom && wKid(rPrFrom, "rPr")
  if (rPr) {
    const copy = rPr.cloneNode(true) as Element
    for (const change of Array.from(copy.getElementsByTagNameNS(rPr.namespaceURI, "rPrChange"))) removeNode(change)
    r.appendChild(copy)
  }
  for (const piece of text.split(/(\t|\n)/)) {
    if (piece === "\t") r.appendChild(wEl(doc, "tab"))
    else if (piece === "\n") r.appendChild(wEl(doc, "br"))
    else if (piece) r.appendChild(wText(doc, "t", piece))
  }
  return r
}

const applyHunk = (p: Element, hunk: EditHunk, who: RevisionAuthor): void => {
  const doc = p.ownerDocument
  splitAt(p, hunk.end)
  splitAt(p, hunk.start)
  const spans = runSpans(p)
  const inside = spans.filter((s) => s.start >= hunk.start && s.end <= hunk.end && s.end > s.start)
  const before = spans.filter((s) => s.end <= hunk.start && s.end > s.start).pop() ?? null
  const after = spans.find((s) => s.start >= hunk.end && s.end > s.start) ?? null

  // Bọc phần xoá: gom run liền kề cùng cha vào một w:del
  let lastDel: Element | null = null
  for (const s of inside) {
    if (lastDel && lastDel.nextSibling === s.r) {
      lastDel.appendChild(s.r)
    } else {
      lastDel = revisionEl(doc, "del", who)
      s.r.parentNode!.insertBefore(lastDel, s.r)
      lastDel.appendChild(s.r)
    }
    toDeleted(s.r)
  }

  if (!hunk.inserted) return
  const ins = revisionEl(doc, "ins", who)
  ins.appendChild(buildInsertedRun(doc, hunk.inserted, inside[0]?.r ?? before?.r ?? after?.r ?? null))
  if (lastDel) placeOutsideRevisions(ins, lastDel, "after", who)
  else if (before) placeOutsideRevisions(ins, before.r, "after", who)
  else if (after) placeOutsideRevisions(ins, after.r, "before", who)
  else {
    // Đoạn rỗng: chèn sau pPr / bookmark đầu đoạn
    let ref: Node | null = wKid(p, "pPr")?.nextSibling ?? p.firstChild
    while (ref && (isW(ref, "bookmarkStart") || isW(ref, "bookmarkEnd"))) ref = ref.nextSibling
    p.insertBefore(ins, ref)
  }
}

/**
 * Sửa đoạn `p` từ `oldText` sang `newText` dạng Track Changes. `oldText` phải khớp text hiện tại của đoạn
 * (so sau chuẩn hoá khoảng trắng) — lệch ⇒ `OoxmlError("OLD_TEXT_MISMATCH")`, không ghi gì.
 */
export const applyEdit = (p: Element, oldText: string, newText: string, who: RevisionAuthor): EditHunk[] => {
  if (!isW(p, "p")) throw new OoxmlError("UNSUPPORTED_CONTENT", "applyEdit chỉ nhận w:p")
  const current = paragraphText(p)
  if (normalizeText(current) !== normalizeText(oldText)) {
    throw new OoxmlError("OLD_TEXT_MISMATCH", `Text hiện tại "${current.slice(0, 60)}" khác old_text "${oldText.slice(0, 60)}"`)
  }
  const hunks = diffWords(current, newText)
  for (const h of [...hunks].reverse()) applyHunk(p, h, who)
  return hunks
}
