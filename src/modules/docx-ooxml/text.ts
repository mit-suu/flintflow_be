/**
 * Text "đang hiệu lực" của một đoạn (`w:p`): như khi Accept all — bỏ phần `w:del`/`w:moveFrom`, lấy phần `w:ins`.
 * Không đi vào textbox/drawing nằm trong run (đó là block khác, xem `blocks.ts`). FLF-171, plan §6 2A.
 */

import { createHash } from "node:crypto"
import { isW } from "./xml.js"

/** Container cấp run được đi xuyên qua khi tìm run hiển thị. */
const RUN_CONTAINERS = new Set(["ins", "moveTo", "hyperlink", "smartTag", "customXml", "fldSimple", "sdt", "sdtContent", "dir", "bdo"])
/** Container chứa nội dung đã xoá — không hiển thị. */
const DELETED_CONTAINERS = new Set(["del", "moveFrom"])

/** Run hiển thị của đoạn theo thứ tự (kể cả run nằm trong `w:ins`, hyperlink, content control cấp run). */
export const visibleRuns = (p: Element): Element[] => {
  const out: Element[] = []
  const walk = (node: Node): void => {
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (!isW(c)) continue
      if (c.localName === "r") out.push(c)
      else if (DELETED_CONTAINERS.has(c.localName)) continue
      else if (RUN_CONTAINERS.has(c.localName)) walk(c)
    }
  }
  walk(p)
  return out
}

/** Text của một phần tử con trong run; `null` = không phải nội dung chữ (rPr, drawing…). */
export const runChildText = (el: Element): string | null => {
  if (!isW(el)) return null
  switch (el.localName) {
    case "t":
      return el.textContent ?? ""
    case "tab":
      return "\t"
    case "br":
    case "cr":
      return "\n"
    case "noBreakHyphen":
      return "-"
    default:
      return null
  }
}

export const runText = (r: Element): string => {
  let s = ""
  for (let c = r.firstChild; c; c = c.nextSibling) s += runChildText(c as Element) ?? ""
  return s
}

export const paragraphText = (p: Element): string => visibleRuns(p).map(runText).join("")

/** Chuẩn hoá để so khớp: gộp khoảng trắng, bỏ đầu/cuối. */
export const normalizeText = (s: string): string => s.replace(/\s+/g, " ").trim()

/** Hash text đã chuẩn hoá (neo phụ của block, kiểm `old_text` ở C-5). */
export const textHash = (s: string): string => createHash("sha256").update(normalizeText(s)).digest("hex").slice(0, 16)
