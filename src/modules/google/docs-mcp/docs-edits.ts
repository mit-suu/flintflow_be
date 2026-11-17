/**
 * docs-edits.ts
 * ─────────────────────────────────────────────────────────────────
 * Dựng request `documents.batchUpdate` cho tool ghi của MCP server, kèm bản xem trước cho `dryRun`. Model chỉ nói "thay chữ
 * X bằng Y" hay "chèn vào cuối mục Z"; chỉ số chèn do server tính từ cấu trúc vừa đọc (`docs-structure.ts`).
 */
import type { docs_v1 } from "@googleapis/docs"
import { DocsToolError, findHeading, headingBefore, type DocStructure } from "./docs-structure.js"

const SAMPLE_LIMIT = 5
const CONTEXT_RADIUS = 40

export interface ReplacePlan {
  matches: number
  samples: Array<{ heading: string | null; before: string; after: string }>
  requests: docs_v1.Schema$Request[]
}

const countOccurrences = (haystack: string, needle: string): number[] => {
  const positions: number[] = []
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) positions.push(i)
  return positions
}

/**
 * Thay mọi chỗ `find` bằng `replace` (`replaceAllText` của Docs API: khớp đúng chữ, không khớp qua ranh giới đoạn).
 * Bản xem trước đếm số chỗ khớp và lấy tối đa 5 mẫu trước / sau kèm mục chứa nó.
 */
export const planReplace = (structure: DocStructure, find: string, replace: string, matchCase: boolean): ReplacePlan => {
  if (!find) throw new DocsToolError("FIND_EMPTY", "Chuỗi cần tìm không được rỗng.")
  const samples: ReplacePlan["samples"] = []
  let matches = 0
  structure.blocks.forEach((block, blockIndex) => {
    const haystack = matchCase ? block.text : block.text.toLowerCase()
    const positions = countOccurrences(haystack, matchCase ? find : find.toLowerCase())
    matches += positions.length
    for (const pos of positions) {
      if (samples.length >= SAMPLE_LIMIT) break
      const start = Math.max(0, pos - CONTEXT_RADIUS)
      const end = Math.min(block.text.length, pos + find.length + CONTEXT_RADIUS)
      const before = block.text.slice(start, end)
      samples.push({
        heading: headingBefore(structure, blockIndex),
        before,
        after: before.slice(0, pos - start) + replace + before.slice(pos - start + find.length)
      })
    }
  })
  return {
    matches,
    samples,
    requests: [{ replaceAllText: { containsText: { text: find, matchCase }, replaceText: replace } }]
  }
}

export type InsertTarget = { afterHeading: string } | { atEnd: true }

export interface InsertPlan {
  /** Mô tả chỗ chèn cho người duyệt: tên mục hoặc cuối tài liệu. */
  location: string
  index: number
  text: string
  asHeading: boolean
  headingLevel: number | null
  requests: docs_v1.Schema$Request[]
}

/**
 * Chèn `text` (một hoặc nhiều đoạn) vào **cuối** mục `afterHeading` (trước heading kế tiếp cùng cấp hoặc cao hơn), hoặc vào
 * cuối tài liệu. `asHeading` ⇒ dòng đầu thành heading cấp con của mục đó (cuối tài liệu: cấp 1), phần còn lại là chữ thường.
 *
 * Đoạn chèn vào luôn được đặt lại kiểu đoạn: chèn ngay trước một heading thì Docs cho đoạn mới thừa kiểu heading đó.
 */
export const planInsert = (structure: DocStructure, target: InsertTarget, rawText: string, asHeading: boolean): InsertPlan => {
  const text = rawText.replace(/\r\n?/g, "\n").replace(/\n+$/, "")
  if (!text.trim()) throw new DocsToolError("TEXT_EMPTY", "Nội dung cần chèn không được rỗng.")

  // Chèn trước ký tự xuống dòng cuối cùng ⇒ thêm đoạn mới sau đoạn cuối
  const atBodyEnd = { index: structure.bodyEnd - 1, inserted: `\n${text}`, rangeStart: structure.bodyEnd }
  let location = "Cuối tài liệu"
  let parentLevel = 0
  let position = atBodyEnd
  if ("afterHeading" in target) {
    const heading = findHeading(structure, target.afterHeading)
    location = heading.text
    parentLevel = heading.level
    // Đầu heading kế tiếp là ranh giới đoạn ⇒ chèn "chữ\n" thành đoạn mới ngay trước nó
    if (heading.sectionEnd < structure.bodyEnd) {
      position = { index: heading.sectionEnd, inserted: `${text}\n`, rangeStart: heading.sectionEnd }
    }
  }

  const { index, inserted, rangeStart } = position
  const headingLevel = asHeading ? Math.min(parentLevel + 1, 6) : null
  const firstLineEnd = rangeStart + (text.includes("\n") ? text.indexOf("\n") : text.length)
  const requests: docs_v1.Schema$Request[] = [
    { insertText: { location: { index }, text: inserted } },
    {
      updateParagraphStyle: {
        range: { startIndex: rangeStart, endIndex: rangeStart + text.length },
        paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
        fields: "namedStyleType"
      }
    }
  ]
  if (headingLevel) {
    requests.push({
      updateParagraphStyle: {
        range: { startIndex: rangeStart, endIndex: firstLineEnd },
        paragraphStyle: { namedStyleType: `HEADING_${headingLevel}` },
        fields: "namedStyleType"
      }
    })
  }
  return { location, index, text, asHeading, headingLevel, requests }
}
