/**
 * Accept all Track Changes bằng code để ra bản sạch khi release (nút 6.2) + bỏ comment do FlintFlow tạo.
 * FLF-171, plan §6 2A; P0 §4.5: text trùng 100% với Accept all của Word.
 * Bookmark neo `_ff_` được giữ: bản release là nền cho CR tiếp theo.
 */

import { CR_AUTHOR_PATTERN } from "../import/import.constants.js"
import { removeComments } from "./comments.js"
import type { DocxPackage } from "./package.js"
import { isW, removeNode, unwrap, wAll, wKid } from "./xml.js"

const REVISABLE_PARTS = /^word\/(document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml$/

const PROPERTY_CHANGES = [
  "rPrChange",
  "pPrChange",
  "sectPrChange",
  "tblPrChange",
  "tblGridChange",
  "trPrChange",
  "tcPrChange",
  "numberingChange",
  "moveFromRangeStart",
  "moveFromRangeEnd",
  "moveToRangeStart",
  "moveToRangeEnd"
]

export interface AcceptAllResult {
  parts: string[]
  revisions: number
  comments: number
}

/** Dấu đoạn bị xoá (`w:pPr/w:rPr/w:del`) ⇒ gộp nội dung đoạn này vào đầu đoạn kế tiếp (như Word). */
const mergeDeletedParagraphMark = (marker: Element): void => {
  const p = marker.parentNode?.parentNode?.parentNode
  removeNode(marker)
  if (!isW(p, "p")) return
  const next = p.nextSibling && isW(p.nextSibling, "p") ? p.nextSibling : null
  if (!next) return
  const nextPPr = wKid(next, "pPr")
  const ref = nextPPr ? nextPPr.nextSibling : next.firstChild
  for (let c: Node | null = p.firstChild; c; ) {
    const nextNode: Node | null = c.nextSibling
    if (!isW(c, "pPr")) next.insertBefore(c, ref)
    c = nextNode
  }
  removeNode(p)
}

const acceptInDocument = (doc: Document): number => {
  let count = 0
  for (const local of ["del", "moveFrom"]) {
    for (const el of wAll(doc, local)) {
      if (!el.parentNode) continue
      count++
      const parent = el.parentNode
      if (isW(parent, "rPr") && isW(parent.parentNode, "pPr")) mergeDeletedParagraphMark(el)
      else if (isW(parent, "trPr")) removeNode(parent.parentNode!)
      else removeNode(el)
    }
  }
  for (const local of ["ins", "moveTo"]) {
    for (const el of wAll(doc, local)) {
      if (!el.parentNode) continue
      count++
      if (isW(el.parentNode, "rPr") || isW(el.parentNode, "trPr")) removeNode(el)
      else unwrap(el)
    }
  }
  for (const local of PROPERTY_CHANGES) {
    for (const el of wAll(doc, local)) {
      count++
      removeNode(el)
    }
  }
  return count
}

/** Accept mọi revision trong mọi part có thể chứa revision; bỏ comment có author là mã CR. */
export const acceptAll = async (pkg: DocxPackage, opts: { dropCommentAuthors?: RegExp } = {}): Promise<AcceptAllResult> => {
  const parts = pkg.partNames().filter((n) => REVISABLE_PARTS.test(n))
  let revisions = 0
  for (const name of parts) revisions += acceptInDocument(await pkg.requireXml(name))
  const comments = await removeComments(pkg, opts.dropCommentAuthors ?? CR_AUTHOR_PATTERN)
  return { parts, revisions, comments }
}
