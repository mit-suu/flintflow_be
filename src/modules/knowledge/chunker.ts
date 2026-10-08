/**
 * Chunker cho Knowledge RAG (FLF-267) — hàm thuần, không đụng đĩa / DB / mạng.
 *
 * Đơn vị là **section dưới `##` / `###`** của một tài liệu markdown (với corpus skill: thân `SKILL.md`). Số đo trên
 * `assets/skills` lúc thiết kế: 39 file, 244 section, ~69k token; section trung vị 203 token, p90 543, max 1857; 18
 * section < 80 token, 9 section > 800 token (phần lớn là danh sách "Rules" đánh số). Nên:
 *   - section < `CHUNK_MIN_TOKENS` ⇒ gộp vào section kế tiếp (section cuối thì gộp vào section trước), nhãn nối heading;
 *   - section > `CHUNK_MAX_TOKENS` ⇒ chỉ cắt ở **ranh giới block**, nhồi tham lam tới ~`CHUNK_TARGET_TOKENS`; danh sách
 *     đánh số thì nhãn mang dải luật (`Rules (4–6)`); một block lớn hơn trần (bảng / code khổng lồ) giữ nguyên, ghi cảnh báo;
 *   - block không bao giờ bị cắt: code fence, bảng, một mục danh sách (kể cả dòng thụt lề nối tiếp và danh sách con).
 *
 * Mỗi chunk có `text` (để hiển thị / đưa vào prompt) và `embed_text` = header ngữ cảnh + `text` (để embed và để
 * tìm theo từ khoá): heading "Rules" xuất hiện ở 27 skill, thiếu header thì 27 chunk "Rules" gần như không phân biệt.
 */

/**
 * Ước lượng token = ceil(ký tự / 3,5). Corpus là tiếng Anh nhiều markdown/ký hiệu; tokenizer BPE thường ra ~3,5–4
 * ký tự/token cho loại chữ này — lấy 3,5 để ước lượng nghiêng về phía nhiều token (an toàn cho trần).
 */
export const CHARS_PER_TOKEN = 3.5
/** Mục tiêu khi nhồi block vào một phần của section dài. */
export const CHUNK_TARGET_TOKENS = 500
/** Section ngắn hơn ngưỡng này bị gộp vào section bên cạnh. */
export const CHUNK_MIN_TOKENS = 80
/** Section dài hơn trần này mới bị cắt. */
export const CHUNK_MAX_TOKENS = 800
/** Section đầu file (trước `##` đầu tiên). */
export const OVERVIEW_HEADING = "Overview"

export const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN)

// ─── tài liệu đầu vào ─────────────────────────────────────────────

export type KnowledgeSourceKind = "internal_skill" | "standard"
export type KnowledgeStatus = "placeholder" | "verified"

/** Một tài liệu của corpus, đã bóc frontmatter (`corpus.ts` dựng). */
export interface KnowledgeDoc {
  corpus: string
  /** Tiền tố id chunk, duy nhất trong corpus — skill: `skill_id`; corpus khác: đường dẫn tương đối không đuôi. */
  doc_id: string
  /** Định danh nguồn, ổn định — skill: `skill_id`; corpus khác: `source` của frontmatter hoặc đường dẫn tương đối. */
  source: string
  source_kind: KnowledgeSourceKind
  /** Skill: `kind` (action/content/renderer/output); corpus khác: `topic`. */
  topic: string
  /** Mô tả một dòng (frontmatter `description`). */
  description: string
  status: KnowledgeStatus
  applies_to: string[]
  /** Nhãn của phần trước `##` đầu tiên (frontmatter `section` của file điều khoản); thiếu ⇒ `Overview`. */
  section?: string
  /** Thân markdown (không frontmatter), xuống dòng LF. Mọi offset `span` tính trên chuỗi này. */
  body: string
}

// ─── tách block ───────────────────────────────────────────────────

export type BlockType = "heading" | "code" | "table" | "list_item" | "paragraph"

export interface Block {
  type: BlockType
  text: string
  /** Offset ký tự trong `body`: [start, end). */
  start: number
  end: number
  /** Heading: cấp (1–6) và chữ. */
  level?: number
  title?: string
  /** Mục danh sách đánh số: số thứ tự (`4.` ⇒ 4); bullet ⇒ undefined. */
  ordinal?: number
}

const FENCE = /^\s*(`{3,}|~{3,})/
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/
const LIST_MARKER = /^(\s*)([-*+]|(\d+)[.)])\s+/
const COMMENT_LINE = /^\s*<!--.*-->\s*$/
const COMMENT_OPEN = /^\s*<!--/

const indentOf = (line: string): number => /^\s*/.exec(line)![0].length
const isBlank = (line: string): boolean => line.trim() === ""
const isTableLine = (line: string): boolean => line.trim().startsWith("|")

/**
 * Tách markdown thành block theo dòng. Không phải parser CommonMark đầy đủ — đủ cho corpus skill: heading `#`,
 * code fence (``` / ~~~, kể cả thụt lề trong mục danh sách), bảng `|`, mục danh sách (dòng nối tiếp thụt lề, danh sách
 * con, dòng "lười" ngay sau không có dòng trống), đoạn văn. Dòng chú thích HTML (`<!-- voice:shared:start -->`) bị bỏ,
 * chữ giữa hai dấu mốc vẫn giữ.
 */
export const tokenizeMarkdown = (body: string): Block[] => {
  const lines = body.split("\n")
  const offsets: number[] = []
  let acc = 0
  for (const line of lines) {
    offsets.push(acc)
    acc += line.length + 1
  }
  const lineEnd = (i: number): number => offsets[i]! + lines[i]!.length
  const blocks: Block[] = []
  const push = (type: BlockType, from: number, to: number, extra: Partial<Block> = {}): void => {
    // Bỏ dòng trống cuối block
    let last = to
    while (last > from && isBlank(lines[last]!)) last--
    const start = offsets[from]!
    const end = lineEnd(last)
    blocks.push({ type, text: body.slice(start, end), start, end, ...extra })
  }
  const startsOtherBlock = (line: string): boolean =>
    FENCE.test(line) || HEADING.test(line) || isTableLine(line) || LIST_MARKER.test(line) || COMMENT_OPEN.test(line)
  /** Đóng fence: dòng chỉ gồm cùng ký tự fence, dài ít nhất bằng fence mở. */
  const closesFence = (line: string, marker: string): boolean => {
    const t = line.trim()
    return t.startsWith(marker) && /^(`+|~+)$/.test(t)
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (isBlank(line) || COMMENT_LINE.test(line)) {
      i++
      continue
    }
    if (COMMENT_OPEN.test(line)) {
      // Chú thích nhiều dòng: bỏ tới dòng có `-->`
      while (i < lines.length && !lines[i]!.includes("-->")) i++
      i++
      continue
    }
    const fence = FENCE.exec(line)
    if (fence) {
      let j = i + 1
      while (j < lines.length && !closesFence(lines[j]!, fence[1]!)) j++
      push("code", i, Math.min(j, lines.length - 1))
      i = j + 1
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      push("heading", i, i, { level: heading[1]!.length, title: heading[2]!.trim() })
      i++
      continue
    }
    if (isTableLine(line)) {
      let j = i
      while (j + 1 < lines.length && isTableLine(lines[j + 1]!)) j++
      push("table", i, j)
      i = j + 1
      continue
    }
    const marker = LIST_MARKER.exec(line)
    if (marker) {
      const indent = marker[1]!.length
      let j = i + 1
      let fenceMarker: string | null = null
      while (j < lines.length) {
        const l = lines[j]!
        if (fenceMarker) {
          if (closesFence(l, fenceMarker)) fenceMarker = null
          j++
          continue
        }
        if (isBlank(l)) {
          // Dòng trống chỉ thuộc mục khi dòng không trống kế tiếp còn thụt lề sâu hơn marker
          let k = j + 1
          while (k < lines.length && isBlank(lines[k]!)) k++
          if (k < lines.length && indentOf(lines[k]!) > indent) {
            j = k
            continue
          }
          break
        }
        if (indentOf(l) > indent) {
          const innerFence = FENCE.exec(l)
          if (innerFence) fenceMarker = innerFence[1]!
          j++
          continue
        }
        // Cùng / ít thụt lề hơn: mục mới, block khác, hoặc dòng "lười" nối tiếp đoạn của mục
        if (startsOtherBlock(l) || COMMENT_LINE.test(l)) break
        j++
      }
      push("list_item", i, j - 1, marker[3] ? { ordinal: Number(marker[3]) } : {})
      i = j
      continue
    }
    let j = i + 1
    while (j < lines.length && !isBlank(lines[j]!) && !startsOtherBlock(lines[j]!) && !COMMENT_LINE.test(lines[j]!)) j++
    push("paragraph", i, j - 1)
    i = j
  }
  return blocks
}

/** Ghép block thành chữ: hai mục danh sách liền nhau cách một dòng, còn lại cách một dòng trống. */
export const renderBlocks = (blocks: readonly Block[]): string =>
  blocks
    .map((b, idx) => {
      if (idx === 0) return b.text
      const prev = blocks[idx - 1]!
      return (prev.type === "list_item" && b.type === "list_item" ? "\n" : "\n\n") + b.text
    })
    .join("")

// ─── section ──────────────────────────────────────────────────────

export interface Section {
  /** `["Rules"]`, `["Lenses", "Ambiguity"]`, `["Overview"]`. */
  path: string[]
  blocks: Block[]
}

/** Chia block theo `##` / `###`. Chữ trước `##` đầu tiên là section `Overview`; `#` và `####`+ là block thường. */
export const splitSections = (blocks: readonly Block[], overview = OVERVIEW_HEADING): Section[] => {
  const sections: Section[] = []
  let current: Section = { path: [overview], blocks: [] }
  let h2: string | null = null
  for (const b of blocks) {
    if (b.type === "heading" && (b.level === 2 || b.level === 3)) {
      if (current.blocks.length) sections.push(current)
      if (b.level === 2) {
        h2 = b.title!
        current = { path: [h2], blocks: [b] }
      } else {
        current = { path: [h2 ?? overview, b.title!], blocks: [b] }
      }
      continue
    }
    current.blocks.push(b)
  }
  if (current.blocks.length) sections.push(current)

  // Section chỉ có dòng heading (vd `## Lenses` ngay trước các `###`) ⇒ dồn heading vào section kế tiếp, giữ path của nó
  const out: Section[] = []
  let carry: Block[] = []
  for (const s of sections) {
    if (s.blocks.every((b) => b.type === "heading")) {
      carry.push(...s.blocks)
      continue
    }
    out.push({ path: s.path, blocks: [...carry, ...s.blocks] })
    carry = []
  }
  if (carry.length) {
    if (out.length) out[out.length - 1]!.blocks.push(...carry)
    else out.push({ path: [overview], blocks: carry })
  }
  return out
}

// ─── chunk ────────────────────────────────────────────────────────

export interface KnowledgeChunkDraft {
  chunk_id: string
  corpus: string
  source: string
  source_kind: KnowledgeSourceKind
  /** Nhãn hiển thị: `Lenses › Ambiguity`, `Context + Rules`, `Rules (4–6)`. */
  section: string
  heading_path: string[]
  /** Id nhóm cả section (trước khi cắt) — để mở rộng small-to-big. Chunk không bị cắt: `parent_id = chunk_id`. */
  parent_id: string
  /** Thứ tự trong nhóm `parent_id` (0-based). */
  part: number
  applies_to: string[]
  topic: string
  status: KnowledgeStatus
  text: string
  embed_text: string
  /** Token ước lượng của `text`. */
  tokens: number
  /** Offset ký tự trong `body` của tài liệu: [start, end). Dùng đo trùng khớp ở eval. */
  span: [number, number]
  /** Gồm ≥ 2 section gộp lại. */
  merged: boolean
  /** Là một phần của section bị cắt. */
  split: boolean
}

export interface ChunkWarning {
  chunk_id: string
  tokens: number
  message: string
}

export interface ChunkResult {
  chunks: KnowledgeChunkDraft[]
  warnings: ChunkWarning[]
}

/** Slug cho id: chữ thường, ký tự lạ ⇒ `-`. */
export const slugify = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "section"

/** Dòng header ngữ cảnh nối trước `text` khi embed (không có trong `text` hiển thị). */
export const contextualHeader = (doc: Pick<KnowledgeDoc, "source" | "source_kind" | "topic" | "description">, section: string): string => {
  const head =
    doc.source_kind === "internal_skill"
      ? `Skill: ${doc.source} (${doc.topic})${doc.description ? ` — ${doc.description}` : ""}`
      : `Source: ${doc.source} (${doc.source_kind})${doc.topic ? ` — ${doc.topic}` : ""}${doc.description ? ` — ${doc.description}` : ""}`
  return `${head}\nSection: ${section}\n---\n`
}

interface Unit {
  paths: string[][]
  blocks: Block[]
}

const unitText = (u: Unit): string => renderBlocks(u.blocks)
const unitTokens = (u: Unit): number => estimateTokens(unitText(u))
const pathLabel = (p: readonly string[]): string => p.join(" › ")
const pathSlug = (p: readonly string[]): string => p.map(slugify).join(".")

/** Gộp section < `CHUNK_MIN_TOKENS` vào section kế tiếp (cuối file ⇒ vào section trước). */
export const mergeSmallSections = (sections: readonly Section[], minTokens = CHUNK_MIN_TOKENS): Unit[] => {
  const units: Unit[] = []
  let pending: Unit | null = null
  for (const s of sections) {
    const unit: Unit = pending ? { paths: [...pending.paths, s.path], blocks: [...pending.blocks, ...s.blocks] } : { paths: [s.path], blocks: [...s.blocks] }
    pending = null
    if (unitTokens(unit) < minTokens) pending = unit
    else units.push(unit)
  }
  if (pending) {
    const last = units.pop()
    units.push(last ? { paths: [...last.paths, ...pending.paths], blocks: [...last.blocks, ...pending.blocks] } : pending)
  }
  return units
}

/**
 * Cắt một dãy block dài thành các phần ~`target` token, chỉ ở ranh giới block. Phần cuối quá nhỏ (< `minTokens`) được
 * gộp ngược vào phần trước nếu không vượt `maxTokens`.
 */
export const packBlocks = (blocks: readonly Block[], target = CHUNK_TARGET_TOKENS, minTokens = CHUNK_MIN_TOKENS, maxTokens = CHUNK_MAX_TOKENS): Block[][] => {
  const parts: Block[][] = []
  let current: Block[] = []
  for (const b of blocks) {
    if (current.length && estimateTokens(renderBlocks([...current, b])) > target) {
      parts.push(current)
      current = []
    }
    current.push(b)
  }
  if (current.length) parts.push(current)
  if (parts.length >= 2) {
    const tail = parts[parts.length - 1]!
    const prev = parts[parts.length - 2]!
    if (estimateTokens(renderBlocks(tail)) < minTokens && estimateTokens(renderBlocks([...prev, ...tail])) <= maxTokens) {
      parts.splice(parts.length - 2, 2, [...prev, ...tail])
    }
  }
  // Heading đứng một mình ở cuối một phần thì chuyển sang đầu phần sau (heading thuộc về nội dung đi sau nó)
  for (let p = 0; p < parts.length - 1; p++) {
    const part = parts[p]!
    while (part.length > 1 && part[part.length - 1]!.type === "heading") parts[p + 1]!.unshift(part.pop()!)
  }
  return parts
}

/** Dải số thứ tự của các mục danh sách đánh số trong một phần — `null` khi phần không có mục đánh số. */
const ordinalRange = (blocks: readonly Block[]): [number, number] | null => {
  const nums = blocks.filter((b) => b.type === "list_item" && b.ordinal !== undefined).map((b) => b.ordinal!)
  return nums.length ? [nums[0]!, nums[nums.length - 1]!] : null
}

/** Chunk một tài liệu. Id chunk duy nhất trong tài liệu (trùng ⇒ thêm `~2`, `~3`). */
export const chunkDocument = (doc: KnowledgeDoc): ChunkResult => {
  const sections = splitSections(tokenizeMarkdown(doc.body), doc.section || OVERVIEW_HEADING)
  const units = mergeSmallSections(sections)
  const chunks: KnowledgeChunkDraft[] = []
  const warnings: ChunkWarning[] = []
  const used = new Set<string>()
  const unique = (id: string): string => {
    let candidate = id
    for (let n = 2; used.has(candidate); n++) candidate = `${id}~${n}`
    used.add(candidate)
    return candidate
  }

  for (const unit of units) {
    const baseLabel = unit.paths.map(pathLabel).join(" + ")
    const baseSlug = unit.paths.map(pathSlug).join("+")
    const parentId = unique(`${doc.doc_id}#${baseSlug}`)
    const split = unitTokens(unit) > CHUNK_MAX_TOKENS
    const parts = split ? packBlocks(unit.blocks) : [unit.blocks]
    parts.forEach((blocks, idx) => {
      const text = renderBlocks(blocks)
      let section = baseLabel
      let chunkId = parentId
      if (parts.length > 1) {
        const range = ordinalRange(blocks)
        const rangeLabel = range ? (range[0] === range[1] ? `${range[0]}` : `${range[0]}–${range[1]}`) : `part ${idx + 1}`
        const rangeSlug = range ? (range[0] === range[1] ? `${range[0]}` : `${range[0]}-${range[1]}`) : `part-${idx + 1}`
        section = `${baseLabel} (${rangeLabel})`
        chunkId = unique(`${parentId}/${rangeSlug}`)
      }
      const tokens = estimateTokens(text)
      if (tokens > CHUNK_MAX_TOKENS) {
        warnings.push({ chunk_id: chunkId, tokens, message: `block đơn lớn hơn trần ${CHUNK_MAX_TOKENS} token — giữ nguyên, không cắt` })
      }
      chunks.push({
        chunk_id: chunkId,
        corpus: doc.corpus,
        source: doc.source,
        source_kind: doc.source_kind,
        section,
        heading_path: [...unit.paths[0]!],
        parent_id: parentId,
        part: idx,
        applies_to: [...doc.applies_to],
        topic: doc.topic,
        status: doc.status,
        text,
        embed_text: contextualHeader(doc, section) + text,
        tokens,
        span: [blocks[0]!.start, blocks[blocks.length - 1]!.end],
        merged: unit.paths.length > 1,
        split: parts.length > 1
      })
    })
  }
  return { chunks, warnings }
}

/** Chunk cả corpus; id chunk là duy nhất trong corpus vì có tiền tố `doc_id` (corpus không được trùng `doc_id`). */
export const chunkCorpus = (docs: readonly KnowledgeDoc[]): ChunkResult => {
  const ids = new Set<string>()
  const all: ChunkResult = { chunks: [], warnings: [] }
  for (const doc of docs) {
    if (ids.has(doc.doc_id)) throw new Error(`Corpus có hai tài liệu cùng doc_id "${doc.doc_id}"`)
    ids.add(doc.doc_id)
    const r = chunkDocument(doc)
    all.chunks.push(...r.chunks)
    all.warnings.push(...r.warnings)
  }
  return all
}

// ─── thống kê (dry-run) ───────────────────────────────────────────

export interface ChunkStats {
  documents: number
  chunks: number
  tokens: { total: number; p50: number; p90: number; max: number; min: number }
  /** Chunk gồm ≥ 2 section gộp. */
  merged: number
  /** Section bị cắt (đếm nhóm, không đếm phần). */
  split_sections: number
  /** Số chunk sinh ra từ section bị cắt. */
  split_chunks: number
  oversized: ChunkWarning[]
}

const percentile = (sorted: readonly number[], p: number): number =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]! : 0

export const chunkStats = (docs: number, result: ChunkResult): ChunkStats => {
  const tokens = result.chunks.map((c) => c.tokens).sort((a, b) => a - b)
  const splitChunks = result.chunks.filter((c) => c.split)
  return {
    documents: docs,
    chunks: result.chunks.length,
    tokens: {
      total: tokens.reduce((s, t) => s + t, 0),
      p50: percentile(tokens, 50),
      p90: percentile(tokens, 90),
      max: tokens[tokens.length - 1] ?? 0,
      min: tokens[0] ?? 0
    },
    merged: result.chunks.filter((c) => c.merged).length,
    split_sections: new Set(splitChunks.map((c) => c.parent_id)).size,
    split_chunks: splitChunks.length,
    oversized: result.warnings
  }
}
