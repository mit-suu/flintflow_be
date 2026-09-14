import type { Block, InlineRun, TableCell } from "./rendered-document.types.js"

/**
 * Markdown giới hạn → Block[]: heading, đoạn, `**bold**`, `*italic*`, `code` inline,
 * bullet, numbered, bảng GFM. Cú pháp khác (link, ảnh, code block, quote, đường kẻ)
 * giữ nguyên dạng chữ; đường kẻ `---` bị bỏ.
 */

export interface MarkdownToBlocksOptions {
  /** Cộng vào cấp heading: section cấp 2 truyền 2 để `#` thành heading cấp 3. Kết quả chặn ở 6. */
  headingOffset?: number
}

type RunStyle = Omit<InlineRun, "text">

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const BULLET = /^\s*[-*+]\s+(.*)$/
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/
const HORIZONTAL_RULE = /^\s*([-*_])(\s*\1){2,}\s*$/

export function markdownToBlocks(markdown: string, options: MarkdownToBlocksOptions = {}): Block[] {
  const offset = options.headingOffset ?? 0
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n")
  const blocks: Block[] = []
  let paragraph: string[] = []

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ type: "paragraph", runs: parseInline(paragraph.join(" ")) })
      paragraph = []
    }
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    if (line.trim() === "") {
      flushParagraph()
      i++
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      flushParagraph()
      blocks.push({
        type: "heading",
        level: Math.min(6, Math.max(1, heading[1].length + offset)),
        text: runsToPlain(parseInline(heading[2]))
      })
      i++
      continue
    }

    if (line.includes("|") && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1])) {
      flushParagraph()
      const header = splitTableRow(line)
      const rows: TableCell[][] = []
      i += 2
      while (i < lines.length && lines[i].trim() !== "" && lines[i].includes("|")) {
        rows.push(splitTableRow(lines[i]))
        i++
      }
      blocks.push({ type: "table", header, rows })
      continue
    }

    if (HORIZONTAL_RULE.test(line)) {
      flushParagraph()
      i++
      continue
    }

    const listKind = BULLET.test(line) ? "bullet_list" : NUMBERED.test(line) ? "numbered_list" : null
    if (listKind) {
      flushParagraph()
      const pattern = listKind === "bullet_list" ? BULLET : NUMBERED
      const items: InlineRun[][] = []
      let match: RegExpExecArray | null
      while (i < lines.length && (match = pattern.exec(lines[i]))) {
        items.push(parseInline(match[1]))
        i++
      }
      blocks.push({ type: listKind, items })
      continue
    }

    paragraph.push(line.trim())
    i++
  }

  flushParagraph()
  return blocks
}

function splitTableRow(line: string): TableCell[] {
  let body = line.trim()
  if (body.startsWith("|")) body = body.slice(1)
  if (body.endsWith("|") && !body.endsWith("\\|")) body = body.slice(0, -1)

  const cells: string[] = []
  let current = ""
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\" && body[i + 1] === "|") {
      // giữ escape để parseInline trả về "|" chữ
      current += "\\|"
      i++
    } else if (body[i] === "|") {
      cells.push(current)
      current = ""
    } else {
      current += body[i]
    }
  }
  cells.push(current)
  return cells.map((cell) => parseInline(cell.trim()))
}

export function parseInline(source: string, style: RunStyle = {}): InlineRun[] {
  const runs: InlineRun[] = []
  let buffer = ""

  const emit = (text: string, runStyle: RunStyle) => {
    if (!text) return
    const last = runs[runs.length - 1]
    if (last && sameStyle(last, runStyle)) {
      last.text += text
    } else {
      runs.push({ text, ...runStyle })
    }
  }
  const flush = () => {
    emit(buffer, style)
    buffer = ""
  }

  let i = 0
  while (i < source.length) {
    const ch = source[i]

    if (ch === "\\" && i + 1 < source.length && "\\`*_|#".includes(source[i + 1])) {
      buffer += source[i + 1]
      i += 2
      continue
    }

    if (ch === "`") {
      const end = source.indexOf("`", i + 1)
      if (end > i + 1) {
        flush()
        emit(source.slice(i + 1, end), { ...style, code: true })
        i = end + 1
        continue
      }
    }

    if (source.startsWith("**", i)) {
      let end = source.indexOf("**", i + 2)
      // `***x***`: dấu đóng bold là hai sao cuối
      if (end !== -1 && source[end + 2] === "*") end += 1
      if (end > i + 2) {
        flush()
        for (const run of parseInline(source.slice(i + 2, end), { ...style, bold: true })) {
          const { text, ...runStyle } = run
          emit(text, runStyle)
        }
        i = end + 2
        continue
      }
    }

    if (ch === "*" && i + 1 < source.length && source[i + 1] !== " " && source[i + 1] !== "*") {
      const end = findItalicClose(source, i + 1)
      if (end !== -1) {
        flush()
        for (const run of parseInline(source.slice(i + 1, end), { ...style, italic: true })) {
          const { text, ...runStyle } = run
          emit(text, runStyle)
        }
        i = end + 1
        continue
      }
    }

    buffer += ch
    i++
  }

  flush()
  return runs
}

function findItalicClose(source: string, from: number): number {
  let j = from
  while (j < source.length) {
    if (source[j] === "\\") {
      j += 2
      continue
    }
    if (source[j] === "`") {
      const end = source.indexOf("`", j + 1)
      j = end === -1 ? j + 1 : end + 1
      continue
    }
    if (source.startsWith("**", j)) {
      const end = source.indexOf("**", j + 2)
      if (end !== -1) {
        j = end + 2
        continue
      }
    }
    if (source[j] === "*" && source[j - 1] !== " ") return j
    j++
  }
  return -1
}

function sameStyle(a: RunStyle, b: RunStyle): boolean {
  return !!a.bold === !!b.bold && !!a.italic === !!b.italic && !!a.code === !!b.code
}

function runsToPlain(runs: InlineRun[]): string {
  return runs.map((run) => run.text).join("")
}
