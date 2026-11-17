/**
 * docs-structure.ts
 * ─────────────────────────────────────────────────────────────────
 * Đọc kết quả `documents.get` của Google Docs API thành: các khối chữ (đoạn văn, bảng) kèm vùng chỉ số, và mục lục heading
 * kèm phạm vi từng mục. Tool MCP chỉ trả các bản gọn này — không bao giờ trả nguyên cấu trúc tài liệu cho model.
 *
 * Chỉ số (index) là đơn vị UTF-16 của Docs API; model không bao giờ thấy hay gửi index — server tự tính từ heading.
 */
import type { docs_v1 } from "@googleapis/docs"
import { foldVietnamese, vietnameseSearchPattern } from "../../../shared/utils/vi-search.js"

export interface DocBlock {
  kind: "paragraph" | "table"
  text: string
  startIndex: number
  endIndex: number
  /** 1–6 với đoạn kiểu HEADING_n; 0 = không phải heading (bảng luôn 0). */
  headingLevel: number
}

export interface DocHeading {
  level: number
  text: string
  /** Vị trí khối heading trong `blocks`. */
  blockIndex: number
  startIndex: number
  endIndex: number
  /** Chỉ số kết thúc nội dung của mục = đầu heading kế tiếp cùng cấp hoặc cao hơn, hoặc cuối thân tài liệu. */
  sectionEnd: number
  /** Số ký tự chữ trong mục (không gồm dòng heading). */
  chars: number
}

export interface DocStructure {
  documentId: string
  title: string
  revisionId: string
  blocks: DocBlock[]
  headings: DocHeading[]
  /** `endIndex` của phần tử cuối thân tài liệu. */
  bodyEnd: number
}

/** Lỗi do tham số của tool (không tìm thấy / trùng heading) — trả cho model kèm danh sách để nó hỏi lại user. */
export class DocsToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly meta?: Record<string, unknown>
  ) {
    super(message)
    this.name = "DocsToolError"
  }
}

const HEADING_STYLE = /^HEADING_([1-6])$/

const paragraphText = (paragraph: docs_v1.Schema$Paragraph | undefined): string =>
  (paragraph?.elements ?? []).map((el) => el.textRun?.content ?? "").join("")

const tableText = (table: docs_v1.Schema$Table): string =>
  (table.tableRows ?? [])
    .map((row) =>
      (row.tableCells ?? [])
        .map((cell) => (cell.content ?? []).map((el) => paragraphText(el.paragraph).trim()).filter(Boolean).join(" "))
        .join(" | ")
    )
    .join("\n")

export const parseDocument = (doc: docs_v1.Schema$Document): DocStructure => {
  const content = doc.body?.content ?? []
  const blocks: DocBlock[] = []
  for (const el of content) {
    if (el.startIndex == null || el.endIndex == null) continue // section break đầu thân tài liệu
    if (el.paragraph) {
      const match = HEADING_STYLE.exec(el.paragraph.paragraphStyle?.namedStyleType ?? "")
      blocks.push({
        kind: "paragraph",
        text: paragraphText(el.paragraph).replace(/\n$/, ""),
        startIndex: el.startIndex,
        endIndex: el.endIndex,
        headingLevel: match ? Number(match[1]) : 0
      })
    } else if (el.table) {
      blocks.push({ kind: "table", text: tableText(el.table), startIndex: el.startIndex, endIndex: el.endIndex, headingLevel: 0 })
    }
  }
  const bodyEnd = content[content.length - 1]?.endIndex ?? 1

  const headings: DocHeading[] = []
  blocks.forEach((block, blockIndex) => {
    if (!block.headingLevel || !block.text.trim()) return
    const next = blocks.findIndex((b, i) => i > blockIndex && b.headingLevel > 0 && b.headingLevel <= block.headingLevel && b.text.trim())
    const sectionBlocks = blocks.slice(blockIndex + 1, next === -1 ? undefined : next)
    headings.push({
      level: block.headingLevel,
      text: block.text.trim(),
      blockIndex,
      startIndex: block.startIndex,
      endIndex: block.endIndex,
      sectionEnd: next === -1 ? bodyEnd : blocks[next].startIndex,
      chars: sectionBlocks.reduce((sum, b) => sum + b.text.length, 0)
    })
  })

  return { documentId: doc.documentId ?? "", title: doc.title ?? "", revisionId: doc.revisionId ?? "", blocks, headings, bodyEnd }
}

/** Mục lục gọn cho model: cấp, chữ, số ký tự của mục. */
export const outlineOf = (structure: DocStructure) => ({
  documentId: structure.documentId,
  title: structure.title,
  revisionId: structure.revisionId,
  headings: structure.headings.map(({ level, text, chars }) => ({ level, text, chars }))
})

const normalize = (value: string): string => foldVietnamese(value).replace(/\s+/g, " ").trim()
/** "3.2 Use cases" ⇒ "use cases": số mục tự đánh của Word không nằm trong chữ heading, model hay gõ kèm. */
const withoutNumbering = (value: string): string => normalize(value).replace(/^(\d+[.)]?)+\s*/, "")

const MAX_CANDIDATES = 30

/**
 * Tìm heading theo chữ, không phân biệt hoa thường và dấu: khớp đúng ⇒ khớp đúng khi bỏ số mục ⇒ heading chứa chuỗi tìm.
 * Không thấy ⇒ `HEADING_NOT_FOUND` kèm danh sách heading; nhiều mục cùng khớp ⇒ `HEADING_AMBIGUOUS` kèm các mục đó.
 */
export const findHeading = (structure: DocStructure, query: string): DocHeading => {
  const stages: Array<(h: DocHeading) => boolean> = [
    (h) => normalize(h.text) === normalize(query),
    (h) => withoutNumbering(h.text) === withoutNumbering(query),
    (h) => withoutNumbering(query).length > 0 && withoutNumbering(h.text).includes(withoutNumbering(query))
  ]
  for (const matches of stages) {
    const found = structure.headings.filter(matches)
    if (found.length === 1) return found[0]
    if (found.length > 1) {
      throw new DocsToolError("HEADING_AMBIGUOUS", `Có ${found.length} mục cùng khớp "${query}". Hỏi lại người dùng muốn mục nào.`, {
        candidates: found.slice(0, MAX_CANDIDATES).map(({ level, text }) => ({ level, text }))
      })
    }
  }
  throw new DocsToolError("HEADING_NOT_FOUND", `Không thấy mục "${query}" trong tài liệu.`, {
    headings: structure.headings.slice(0, MAX_CANDIDATES).map(({ level, text }) => ({ level, text }))
  })
}

/** Chữ của một mục (gồm cả mục con), cắt ở `maxChars`. */
export const sectionText = (structure: DocStructure, heading: DocHeading, maxChars: number) => {
  const text = structure.blocks
    .filter((b) => b.startIndex >= heading.endIndex && b.endIndex <= heading.sectionEnd)
    .map((b) => b.text)
    .filter((t) => t.trim())
    .join("\n")
  return {
    heading: heading.text,
    level: heading.level,
    text: text.length > maxChars ? text.slice(0, maxChars) : text,
    truncated: text.length > maxChars,
    totalChars: text.length
  }
}

/** Heading gần nhất phía trước một khối — để biết đoạn khớp nằm ở mục nào. */
export const headingBefore = (structure: DocStructure, blockIndex: number): string | null => {
  for (let i = structure.headings.length - 1; i >= 0; i--) {
    if (structure.headings[i].blockIndex <= blockIndex) return structure.headings[i].text
  }
  return null
}

const SNIPPET_RADIUS = 60

/** Tối đa `limit` đoạn chứa `query` (không phân biệt hoa thường và dấu), kèm heading chứa nó. */
export const searchText = (structure: DocStructure, query: string, limit: number) => {
  const pattern = vietnameseSearchPattern(query)
  const matches: Array<{ heading: string | null; snippet: string }> = []
  let total = 0
  structure.blocks.forEach((block, blockIndex) => {
    const found = pattern.exec(block.text)
    if (!found) return
    total++
    if (matches.length >= limit) return
    const start = Math.max(0, found.index - SNIPPET_RADIUS)
    const end = Math.min(block.text.length, found.index + found[0].length + SNIPPET_RADIUS)
    matches.push({
      heading: headingBefore(structure, blockIndex),
      snippet: `${start > 0 ? "…" : ""}${block.text.slice(start, end)}${end < block.text.length ? "…" : ""}`
    })
  })
  return { query, total, matches }
}
