/**
 * Chia tài liệu upload thành đơn vị truy xuất theo cây section (FLF-393) — hàm thuần.
 *
 * Đầu vào là **mảng đoạn của `splitParagraphs`** (`document-paragraphs.ts`), không phải file gốc: mã đoạn `D<n>-P<m>` là
 * vị trí trong mảng đó, nên chunk chỉ ghi khoảng đoạn `[p_start, p_end]` và mã vẫn đúng với mọi nguồn đã lưu.
 *
 * Heading:
 * - `outline` (heading thật của .docx, `docx-outline.ts`) có thì dùng nó — chữ phẳng của mammoth mất style và số tự đánh.
 * - Không có ⇒ dò trên chữ: markdown `#`, số mục `3.2.1 Tên`, `Chương 2` / `Phụ lục A`. Số một cấp (`4. Tên`) dễ lẫn
 *   với danh sách đánh số nên chỉ nhận khi nối tiếp đúng số mục cấp một trước đó.
 * - Dòng mở đầu bằng mã (`UC-05 Đặt lịch`) luôn là heading lá, nằm dưới mục đang mở.
 * Dò sai chỉ làm ranh giới chunk lệch — tìm bằng BM25 vẫn chạy trên chữ của chunk.
 *
 * Kích thước: gom đoạn tới `CHUNK_TARGET_TOKENS`; mục con quá nhỏ gộp với mục cha / anh em liền kề.
 */

/** Đổi luật cắt ⇒ tăng số này: chunk đã lưu của bản cũ bị coi là thiếu và dựng lại. */
export const CHUNKER_VERSION = 1

export const CHUNK_TARGET_TOKENS = 500
/** Chunk dưới ngưỡng này được gộp với chunk liền kề cùng mục cha. */
export const CHUNK_MIN_TOKENS = 150

/**
 * Ước lượng token cho ngân sách tài liệu: ký tự / 3. Thận trọng hơn mức / 4 dùng ở nơi khác — chữ tiếng Việt có dấu tốn
 * nhiều token hơn tiếng Anh, mà đây là trần cứng nên thà ước dư.
 */
export const estimateDocTokens = (text: string): number => Math.ceil(text.length / 3)

/** Phần chữ mã đoạn `[D1-P03] ` cộng xuống dòng, tính vào token của đoạn. */
const PARAGRAPH_OVERHEAD_CHARS = 12
const paragraphTokens = (p: string): number => Math.ceil((p.length + PARAGRAPH_OVERHEAD_CHARS) / 3)

const MAX_HEADING_CHARS = 120
/** Cấp của heading lá theo mã — sâu hơn mọi cấp số mục. */
const CODE_HEADING_LEVEL = 9

export interface OutlineEntry {
  /** Chỉ số đoạn (0-based) là heading. */
  p: number
  level: number
}

export interface DocumentChunk {
  ordinal: number
  /** Đường dẫn mục của đoạn đầu chunk, từ ngoài vào trong. */
  heading_path: string[]
  /** Mọi tiêu đề chunk thuộc về hoặc chứa bên trong (đường dẫn + heading con đã gộp). */
  titles: string[]
  p_start: number
  p_end: number
  paragraphs: string[]
  tokens: number
}

interface Heading {
  level: number
  title: string
}

const MARKDOWN_HEADING = /^(#{1,6})\s+(\S.*)$/
const NUMBERED_HEADING = /^(\d{1,2}(?:\.\d{1,2}){0,4})\.?\s+(\S.*)$/
const KEYWORD_HEADING = /^(chương|phần|chapter|part|section|appendix|phụ lục)\s+([0-9]{1,3}|[IVXLC]{1,6}|[A-Z])\b/i
const CODE_HEADING = /^(UC|FR|NFR|BR|REQ|US|SR|FN|SCR)[-_ ]?\d{1,4}\b/i
const ENDS_LIKE_SENTENCE = /[.;,:!?]$/

const isTitleLike = (text: string): boolean => text.length <= MAX_HEADING_CHARS && !text.includes("\n") && !ENDS_LIKE_SENTENCE.test(text)

/** Heading theo chữ. `lastTop` = số mục cấp một gần nhất đã nhận (0 = chưa có). */
export const detectHeading = (paragraph: string, lastTop = 0): Heading | null => {
  const text = paragraph.trim()
  if (!text || text.includes("\n") || text.length > MAX_HEADING_CHARS) return null

  const md = MARKDOWN_HEADING.exec(text)
  if (md) return { level: md[1]!.length, title: md[2]!.trim() }

  if (CODE_HEADING.test(text)) return isTitleLike(text) ? { level: CODE_HEADING_LEVEL, title: text } : null

  const numbered = NUMBERED_HEADING.exec(text)
  if (numbered && isTitleLike(text) && /\p{L}/u.test(numbered[2]!)) {
    const parts = numbered[1]!.split(".")
    if (parts.length > 1) return { level: parts.length, title: text }
    // Một cấp: chỉ nhận khi nối tiếp số mục trước (danh sách "1. 2. 3." trong thân bài không nối tiếp được)
    if (Number(parts[0]) === lastTop + 1 && text.split(/\s+/).length <= 14) return { level: 1, title: text }
    return null
  }

  if (KEYWORD_HEADING.test(text) && isTitleLike(text)) return { level: 1, title: text }
  return null
}

const topNumberOf = (title: string): number | null => {
  const m = /^(\d{1,2})\.?\s/.exec(title)
  return m ? Number(m[1]) : null
}

const commonPrefix = (a: readonly string[], b: readonly string[]): string[] => {
  const out: string[] = []
  for (let i = 0; i < Math.min(a.length, b.length) && a[i] === b[i]; i++) out.push(a[i]!)
  return out
}

type Draft = Omit<DocumentChunk, "ordinal">

/** Gộp chunk nhỏ với chunk liền trước khi cùng mục / cha–con / anh em và tổng không quá cỡ đích. */
const mergeSmall = (chunks: Draft[]): Draft[] => {
  const out: Draft[] = []
  for (const cur of chunks) {
    const prev = out[out.length - 1]
    if (prev && prev.tokens + cur.tokens <= CHUNK_TARGET_TOKENS && Math.min(prev.tokens, cur.tokens) < CHUNK_MIN_TOKENS) {
      const common = commonPrefix(prev.heading_path, cur.heading_path)
      if (common.length >= 1 && common.length >= Math.min(prev.heading_path.length, cur.heading_path.length) - 1) {
        out[out.length - 1] = {
          heading_path: common,
          titles: [...new Set([...prev.titles, ...cur.titles])],
          p_start: prev.p_start,
          p_end: cur.p_end,
          paragraphs: [...prev.paragraphs, ...cur.paragraphs],
          tokens: prev.tokens + cur.tokens
        }
        continue
      }
    }
    out.push(cur)
  }
  return out
}

export const chunkParagraphs = (paragraphs: readonly string[], outline: readonly OutlineEntry[] = []): DocumentChunk[] => {
  const outlineLevel = new Map(outline.filter((o) => o.p >= 0 && o.p < paragraphs.length).map((o) => [o.p, o.level]))
  const useOutline = outlineLevel.size > 0

  const stack: Heading[] = []
  const drafts: Draft[] = []
  let cur: Draft | null = null
  let lastTop = 0

  const flush = () => {
    if (cur && cur.paragraphs.length) drafts.push(cur)
    cur = null
  }
  const open = (index: number): Draft => {
    const path = stack.map((h) => h.title)
    return { heading_path: path, titles: [...path], p_start: index, p_end: index, paragraphs: [], tokens: 0 }
  }

  paragraphs.forEach((paragraph, index) => {
    let heading: Heading | null = null
    if (useOutline) {
      const level = outlineLevel.get(index)
      if (level !== undefined) heading = { level, title: paragraph.trim().slice(0, MAX_HEADING_CHARS) }
      else {
        const detected = detectHeading(paragraph)
        // Có outline thì chỉ tin thêm heading lá theo mã — số mục trong chữ dễ là danh sách
        if (detected?.level === CODE_HEADING_LEVEL) heading = detected
      }
    } else {
      heading = detectHeading(paragraph, lastTop)
      if (heading?.level === 1) lastTop = topNumberOf(heading.title) ?? lastTop
    }

    const tokens = paragraphTokens(paragraph)
    if (heading) {
      flush()
      while (stack.length && stack[stack.length - 1]!.level >= heading.level) stack.pop()
      stack.push(heading)
      cur = open(index)
    } else if (!cur) {
      cur = open(index)
    } else if (cur.paragraphs.length && cur.tokens + tokens > CHUNK_TARGET_TOKENS) {
      flush()
      cur = open(index)
    }
    cur!.paragraphs.push(paragraph)
    cur!.p_end = index
    cur!.tokens += tokens
  })
  flush()

  return mergeSmall(drafts).map((d, ordinal) => ({ ordinal, ...d }))
}
