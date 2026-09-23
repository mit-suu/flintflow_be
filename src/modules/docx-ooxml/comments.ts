/**
 * Comment dạng Word (C-7 kết luận `comment`, nút 3.14). FLF-171, plan §6 2A.
 * Tạo `word/comments.xml` (+ rels, content type) nếu chưa có; phạm vi comment bao cả đoạn.
 * Initials: Word hiện nhãn `initials + số thứ tự` (P0 §4.3) ⇒ mặc định `FF` để không thành `[CR0021]`.
 */

import type { DocxPackage } from "./package.js"
import { MAIN_PART } from "./blocks.js"
import { toWDate } from "./track-changes.js"
import { CONTENT_TYPE, NS, REL_TYPE, isW, wAll, wAttr, wEl, wKid, wText } from "./xml.js"

export const COMMENTS_PART = "word/comments.xml"

export interface CommentInfo {
  id: string
  author: string
  text: string
}

const ensureCommentsPart = async (pkg: DocxPackage): Promise<Document> => {
  const existing = await pkg.xml(COMMENTS_PART)
  if (existing) return existing
  const doc = await pkg.addXmlPart(
    COMMENTS_PART,
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments xmlns:w="${NS.w}"/>`,
    CONTENT_TYPE.comments
  )
  await pkg.addRelationship(MAIN_PART, REL_TYPE.comments, "comments.xml")
  return doc
}

/** Thêm comment bao trọn đoạn `p` (đoạn thuộc `word/document.xml` của `pkg`). Trả id comment. */
export const addComment = async (
  pkg: DocxPackage,
  p: Element,
  text: string,
  who: { author: string; date: Date; initials?: string }
): Promise<string> => {
  const cdoc = await ensureCommentsPart(pkg)
  const used = wAll(cdoc, "comment").map((c) => Number(wAttr(c, "id"))).filter(Number.isInteger)
  const main = p.ownerDocument
  const usedRanges = wAll(main, "commentRangeStart").map((c) => Number(wAttr(c, "id"))).filter(Number.isInteger)
  const id = String(Math.max(-1, ...used, ...usedRanges) + 1)

  const comment = wEl(cdoc, "comment", { id, author: who.author, date: toWDate(who.date), initials: who.initials ?? "FF" })
  for (const line of text.split(/\r?\n/)) {
    const cp = wEl(cdoc, "p")
    const cr = wEl(cdoc, "r")
    cr.appendChild(wText(cdoc, "t", line))
    cp.appendChild(cr)
    comment.appendChild(cp)
  }
  cdoc.documentElement.appendChild(comment)

  const start = wEl(main, "commentRangeStart", { id })
  const pPr = wKid(p, "pPr")
  p.insertBefore(start, pPr ? pPr.nextSibling : p.firstChild)
  p.appendChild(wEl(main, "commentRangeEnd", { id }))
  const refRun = wEl(main, "r")
  refRun.appendChild(wEl(main, "commentReference", { id }))
  p.appendChild(refRun)
  return id
}

export const listComments = async (pkg: DocxPackage): Promise<CommentInfo[]> => {
  const cdoc = await pkg.xml(COMMENTS_PART)
  if (!cdoc) return []
  return wAll(cdoc, "comment").map((c) => ({
    id: wAttr(c, "id") ?? "",
    author: wAttr(c, "author") ?? "",
    text: wAll(c, "p")
      .map((p) => wAll(p, "t").map((t) => t.textContent ?? "").join(""))
      .join("\n")
  }))
}

/** Xoá các comment có author khớp `authorPattern` (comment + range + reference trong document). Trả số comment đã xoá. */
export const removeComments = async (pkg: DocxPackage, authorPattern: RegExp): Promise<number> => {
  const cdoc = await pkg.xml(COMMENTS_PART)
  if (!cdoc) return 0
  const drop = new Set<string>()
  for (const c of wAll(cdoc, "comment")) {
    if (authorPattern.test(wAttr(c, "author") ?? "")) {
      drop.add(wAttr(c, "id") ?? "")
      c.parentNode!.removeChild(c)
    }
  }
  if (!drop.size) return 0
  const main = await pkg.requireXml(MAIN_PART)
  for (const local of ["commentRangeStart", "commentRangeEnd", "commentReference"]) {
    for (const el of wAll(main, local)) {
      if (!drop.has(wAttr(el, "id") ?? "")) continue
      // commentReference nằm trong một run riêng ⇒ bỏ cả run nếu run chỉ còn nó
      const run = local === "commentReference" && isW(el.parentNode, "r") ? (el.parentNode as Element) : null
      el.parentNode!.removeChild(el)
      if (run && !Array.from(run.childNodes).some((n) => n.nodeType === 1 && !isW(n, "rPr"))) run.parentNode!.removeChild(run)
    }
  }
  return drop.size
}
