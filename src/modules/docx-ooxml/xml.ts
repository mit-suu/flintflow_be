/**
 * Namespace + helper DOM dùng chung cho thư viện OOXML mode 1 (FLF-171, plan §6 2A).
 * Làm việc trên DOM của `@xmldom/xmldom`; mọi hàm ở đây thuần, không đọc/ghi zip.
 */

import { DOMParser, XMLSerializer } from "@xmldom/xmldom"

export const NS = {
  w: "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  w14: "http://schemas.microsoft.com/office/word/2010/wordml",
  r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  rels: "http://schemas.openxmlformats.org/package/2006/relationships",
  ct: "http://schemas.openxmlformats.org/package/2006/content-types",
  cp: "http://schemas.openxmlformats.org/officeDocument/2006/custom-properties",
  vt: "http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes",
  mc: "http://schemas.openxmlformats.org/markup-compatibility/2006"
} as const

export const REL_TYPE = {
  comments: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments",
  header: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/header",
  customProperties: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties"
} as const

export const CONTENT_TYPE = {
  comments: "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml",
  header: "application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml",
  customProperties: "application/vnd.openxmlformats-officedocument.custom-properties+xml"
} as const

export class OoxmlError extends Error {
  constructor(
    readonly code: "INVALID_XML" | "PART_MISSING" | "PACKAGE_TOO_LARGE" | "OLD_TEXT_MISMATCH" | "UNSUPPORTED_CONTENT",
    message: string
  ) {
    super(message)
    this.name = "OoxmlError"
  }
}

/** Parse XML, lỗi cú pháp ⇒ `OoxmlError("INVALID_XML")` (mặc định xmldom chỉ cảnh báo rồi đi tiếp). */
export const parseXml = (source: string, partName = "xml"): Document => {
  let failure: string | null = null
  const parser = new DOMParser({
    errorHandler: {
      warning: () => undefined,
      error: (msg: string) => {
        failure ??= msg
      },
      fatalError: (msg: string) => {
        failure ??= msg
      }
    }
  })
  const doc = parser.parseFromString(source, "text/xml")
  if (failure || !doc?.documentElement) throw new OoxmlError("INVALID_XML", `${partName}: ${failure ?? "rỗng"}`)
  return doc
}

export const serializeXml = (doc: Document): string => new XMLSerializer().serializeToString(doc)

export const isW = (node: Node | null | undefined, local?: string): node is Element =>
  !!node && node.nodeType === 1 && (node as Element).namespaceURI === NS.w && (!local || (node as Element).localName === local)

/** Con trực tiếp thuộc namespace `w` (lọc theo tên nếu có). */
export const wKids = (node: Node, local?: string): Element[] => {
  const out: Element[] = []
  for (let c = node.firstChild; c; c = c.nextSibling) if (isW(c, local)) out.push(c)
  return out
}

export const wKid = (node: Node, local: string): Element | undefined => wKids(node, local)[0]

/** Mọi hậu duệ `w:<local>` theo thứ tự tài liệu. */
export const wAll = (node: Document | Element, local: string): Element[] =>
  Array.from(node.getElementsByTagNameNS(NS.w, local))

export const wAttr = (el: Element | undefined | null, local: string): string | null => {
  if (!el) return null
  const v = el.getAttributeNS(NS.w, local)
  return v === "" && !el.hasAttributeNS(NS.w, local) ? null : v
}

export const wEl = (doc: Document, local: string, attrs: Record<string, string> = {}): Element => {
  const el = doc.createElementNS(NS.w, `w:${local}`)
  for (const [k, v] of Object.entries(attrs)) el.setAttributeNS(NS.w, `w:${k}`, v)
  return el
}

/** `w:t` giữ khoảng trắng đầu/cuối. */
export const wText = (doc: Document, local: "t" | "delText", text: string): Element => {
  const t = wEl(doc, local)
  t.setAttribute("xml:space", "preserve")
  t.appendChild(doc.createTextNode(text))
  return t
}

export const hasAncestor = (node: Node, local: string, stopAt?: Node): boolean => {
  for (let x = node.parentNode; x && x !== stopAt; x = x.parentNode) if (isW(x, local)) return true
  return false
}

export const insertAfter = (node: Node, ref: Node): void => {
  ref.parentNode!.insertBefore(node, ref.nextSibling)
}

export const removeNode = (node: Node): void => {
  node.parentNode?.removeChild(node)
}

/** Bóc phần tử: đưa con lên thay chỗ nó. */
export const unwrap = (el: Element): void => {
  const parent = el.parentNode!
  while (el.firstChild) parent.insertBefore(el.firstChild, el)
  parent.removeChild(el)
}

/** Số lớn nhất của thuộc tính `w:id` trên các phần tử cho trước (−1 nếu không có). */
export const maxWId = (doc: Document, locals: readonly string[]): number => {
  let max = -1
  for (const local of locals)
    for (const el of wAll(doc, local)) {
      const n = Number(wAttr(el, "id"))
      if (Number.isInteger(n) && n > max) max = n
    }
  return max
}
