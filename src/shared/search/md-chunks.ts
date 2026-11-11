/**
 * FLF-375 — cắt văn bản tự do (tài liệu đính kèm của CR: biên bản họp, email, ghi chú .md / .txt, chữ rút từ .docx /
 * .pdf) **theo cấu trúc** bằng Tree-sitter (grammar Markdown, WASM — `assets/tree-sitter/`). Mỗi đơn vị là một đoạn văn,
 * một mục danh sách, một dòng bảng (kèm dòng tiêu đề bảng) hoặc một khối code, mang **đường tiêu đề** chứa nó
 * ("Biên bản 08/11 › Phụ huynh"). Đoạn dài > `MAX_CHUNK` ký tự cắt tiếp theo câu.
 *
 * Đơn vị này là thứ BM25 chấm điểm để chọn đúng đoạn liên quan đưa cho AI (thay cho cắt cụt phần đầu tài liệu).
 * WASM không nạp được (môi trường thiếu file…) ⇒ cắt theo dòng trống — luồng không hỏng, chỉ mất đường tiêu đề.
 */

import fs from "node:fs"
import path from "node:path"
import { getAssetsRoot } from "../../config/paths.js"

export interface TextChunk {
  /** Vị trí ký tự bắt đầu trong văn bản gốc — để in lại theo đúng thứ tự tài liệu. */
  start: number
  /** Đường tiêu đề chứa đơn vị, rỗng nếu không có. */
  headings: string[]
  text: string
}

export const MAX_CHUNK = 800

/** Node tối thiểu của web-tree-sitter mà hàm này dùng. */
interface SyntaxNode {
  type: string
  text: string
  startIndex: number
  namedChildren: (SyntaxNode | null)[]
}
interface MarkdownParser {
  parse(text: string): { rootNode: SyntaxNode } | null
}

let parserPromise: Promise<MarkdownParser | null> | null = null
let warned = false

/** Nạp parser một lần cho cả process; lỗi ⇒ `null` (dùng cắt dự phòng). */
export const markdownParser = (): Promise<MarkdownParser | null> => {
  parserPromise ??= (async () => {
    try {
      const { Parser, Language } = await import("web-tree-sitter")
      await Parser.init()
      const wasm = path.join(getAssetsRoot(), "tree-sitter", "tree-sitter-markdown.wasm")
      const language = await Language.load(fs.readFileSync(wasm))
      const parser = new Parser()
      parser.setLanguage(language)
      return parser as unknown as MarkdownParser
    } catch (err) {
      if (!warned) console.warn("[md-chunks] không nạp được Tree-sitter Markdown — cắt theo dòng trống", err)
      warned = true
      return null
    }
  })()
  return parserPromise
}

/** Đoạn dài ⇒ cắt theo câu, mỗi phần ≤ `MAX_CHUNK` (câu đơn dài hơn thì để nguyên). */
const splitLong = (chunk: TextChunk): TextChunk[] => {
  if (chunk.text.length <= MAX_CHUNK) return [chunk]
  const sentences = chunk.text.match(/[^.!?\n]+[.!?]*\s*|\n+/g) ?? [chunk.text]
  const out: TextChunk[] = []
  let buf = ""
  let start = chunk.start
  let offset = chunk.start
  for (const s of sentences) {
    if (buf && buf.length + s.length > MAX_CHUNK) {
      out.push({ start, headings: chunk.headings, text: buf.trim() })
      buf = ""
      start = offset
    }
    buf += s
    offset += s.length
  }
  if (buf.trim()) out.push({ start, headings: chunk.headings, text: buf.trim() })
  return out
}

const headingText = (node: SyntaxNode): string => node.text.replace(/^#+\s*/, "").replace(/\s*#*\s*$/, "").trim()

/** Duyệt cây Markdown, gom đơn vị theo thứ tự tài liệu. */
const collect = (node: SyntaxNode, headings: string[], out: TextChunk[]): void => {
  let current = headings
  for (const child of node.namedChildren) {
    if (!child) continue
    switch (child.type) {
      case "section":
        collect(child, current, out)
        break
      case "atx_heading":
      case "setext_heading":
        current = [...headings, headingText(child)]
        break
      case "list":
      case "list_item":
      case "block_quote":
        if (child.type === "list_item" && child.namedChildren.every((c) => !c || !["list", "list_item"].includes(c.type))) {
          out.push({ start: child.startIndex, headings: current, text: child.text.trim() })
        } else collect(child, current, out)
        break
      case "pipe_table": {
        const rows = child.namedChildren.filter((r): r is SyntaxNode => !!r && (r.type === "pipe_table_header" || r.type === "pipe_table_row"))
        const header = rows.find((r) => r.type === "pipe_table_header")?.text.trim() ?? ""
        for (const r of rows.filter((x) => x.type === "pipe_table_row")) out.push({ start: r.startIndex, headings: current, text: header ? `${header}\n${r.text.trim()}` : r.text.trim() })
        break
      }
      case "paragraph":
      case "fenced_code_block":
      case "indented_code_block":
      case "html_block":
        if (child.text.trim()) out.push({ start: child.startIndex, headings: current, text: child.text.trim() })
        break
      default:
        if (child.namedChildren.length) collect(child, current, out)
        else if (child.text.trim()) out.push({ start: child.startIndex, headings: current, text: child.text.trim() })
    }
  }
}

/** Dự phòng không có Tree-sitter: đoạn ngăn bằng dòng trống. */
export const paragraphChunks = (text: string): TextChunk[] => {
  const out: TextChunk[] = []
  const re = /[^\n]+(?:\n(?!\s*\n)[^\n]*)*/g
  for (const m of text.matchAll(re)) if (m[0].trim()) out.push({ start: m.index ?? 0, headings: [], text: m[0].trim() })
  return out.flatMap(splitLong)
}

export const chunkText = async (text: string): Promise<TextChunk[]> => {
  if (!text.trim()) return []
  const parser = await markdownParser()
  const tree = parser?.parse(text)
  if (!tree) return paragraphChunks(text)
  const out: TextChunk[] = []
  collect(tree.rootNode, [], out)
  return out.sort((a, b) => a.start - b.start).flatMap(splitLong)
}
