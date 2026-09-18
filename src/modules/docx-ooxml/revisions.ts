/**
 * Liệt kê Track Changes đang có trong tài liệu (preflight I-1: tác giả khác mã CR ⇒ từ chối). FLF-171, plan §6 2A.
 */

import { MAIN_PART } from "./blocks.js"
import type { DocxPackage } from "./package.js"
import { isW, wAll, wAttr } from "./xml.js"

export const REVISION_ELEMENTS = ["ins", "del", "moveFrom", "moveTo", "rPrChange", "pPrChange"] as const

export interface RevisionInfo {
  kind: (typeof REVISION_ELEMENTS)[number]
  author: string
  element: Element
}

export const listRevisions = async (pkg: DocxPackage, part = MAIN_PART): Promise<RevisionInfo[]> => {
  const doc = await pkg.xml(part)
  if (!doc) return []
  return REVISION_ELEMENTS.flatMap((kind) => wAll(doc, kind).map((element) => ({ kind, author: wAttr(element, "author") ?? "", element })))
}

/** Đoạn `w:p` chứa phần tử (chính nó nếu là `w:p`). */
export const enclosingParagraph = (node: Node | null): Element | null => {
  for (let x = node; x; x = x.parentNode) if (isW(x, "p")) return x
  return null
}

/** Đoạn chứa điểm bắt đầu của comment `id` trong document. */
export const commentParagraph = async (pkg: DocxPackage, id: string): Promise<Element | null> => {
  const doc = await pkg.xml(MAIN_PART)
  if (!doc) return null
  const start =
    wAll(doc, "commentRangeStart").find((s) => wAttr(s, "id") === id) ?? wAll(doc, "commentReference").find((s) => wAttr(s, "id") === id)
  return enclosingParagraph(start ?? null)
}

/** Đoạn chèn/xoá dạng Track Changes trong một đoạn (UC-54: FE tô màu bản draft). Bỏ dấu đổi định dạng. */
export const paragraphRevisions = (p: Element): { kind: "ins" | "del"; text: string; author: string }[] => {
  const out: { kind: "ins" | "del"; text: string; author: string }[] = []
  for (const kind of ["ins", "del"] as const) {
    for (const el of wAll(p, kind)) {
      if (isW(el.parentNode, "rPr") || isW(el.parentNode, "trPr")) continue
      const text =
        kind === "del"
          ? wAll(el, "delText").map((t) => t.textContent ?? "").join("")
          : wAll(el, "t").map((t) => t.textContent ?? "").join("")
      if (text) out.push({ kind, text, author: wAttr(el, "author") ?? "" })
    }
  }
  return out
}
