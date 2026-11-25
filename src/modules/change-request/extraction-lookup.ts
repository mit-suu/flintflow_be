/**
 * FLF-449 (P6, việc 23; BF §3.6.1 bước 2): Code tra SRS cho từng đoạn tài liệu **trước** lượt AI rút yêu cầu (03 #16: một
 * lượt AI, Code tra ứng viên trước) — cùng cách tra của phân tích ảnh hưởng (C-3): nhắc tên / mã (`scanMentions`), từ khoá
 * BM25 (`rankByKeywords`), gần nghĩa (`vectorCandidates`, chỉ khi có index sau baseline — 03 #20; lỗi / không có index ⇒ chỉ
 * từ khoá + nhắc tên). Thay `crProjection(spine, text.slice(0, 8000))` chỉ nhìn 8000 ký tự đầu.
 *
 * - Ứng viên của các đoạn trong lô đi vào prompt (`candidatesText`) để AI gắn nhãn Mới / Sửa đổi / Trùng.
 * - Chỗ đã tra của một yêu cầu (`locatedPathsFor`) = phần tử được nhắc tên / mã trong chính yêu cầu + ứng viên gần nghĩa của
 *   đoạn nguồn. Từ khoá BM25 luôn có "phần tử khớp nhất" kể cả khi không liên quan ⇒ chỉ làm gợi ý cho AI, không thành đích CR.
 */

import { scanMentions } from "../import/mentions.js"
import type { Spine } from "../spine/spine.types.js"
import { ENTITY_ARRAY, namedEntities } from "./cr-context.js"
import { listElements, rankByKeywords, type SpineElement, type VectorCandidate } from "./spine-location.js"

export type CandidateSource = "mention" | "keyword" | "vector"
/** Chỉ số đoạn ⇒ (path phần tử ⇒ cách tìm ra). */
export type ParagraphHits = Map<number, Map<string, Set<CandidateSource>>>

/** Đoạn ngắn hơn ngưỡng (lời chào, ngày họp) không tra từ khoá. */
const KEYWORD_MIN_PARAGRAPH_CHARS = 15
/** Số phần tử tối đa theo từ khoá cho mỗi đoạn. */
export const KEYWORD_HITS_PER_PARAGRAPH = 3
/** Gom đoạn liền nhau thành cửa sổ ~2000 ký tự cho một lần tra gần nghĩa (một lần embed query) — phủ cả tài liệu. */
export const VECTOR_WINDOW_CHARS = 2000
export const VECTOR_HITS_PER_WINDOW = 5
const VECTOR_CONCURRENCY = 4
/** Trần chữ phần ứng viên trong prompt của một lô. */
export const CANDIDATES_CHARS = 6000
const STATEMENT_CHARS = 160

const NAME_FIELDS = ["name", "term", "title"] as const
const TEXT_FIELDS = ["statement", "text", "description", "content"] as const

const valueOf = (spine: Spine, path: string): Record<string, unknown> | null => {
  const m = /^([a-z_]+)\[id=(.+)\]$/.exec(path)
  if (!m) return null
  const list = (spine as unknown as Record<string, unknown>)[m[1]]
  if (!Array.isArray(list)) return null
  return (list.find((el) => el && typeof el === "object" && String((el as { id?: unknown }).id) === m[2]) as Record<string, unknown> | undefined) ?? null
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.replace(/\s+/g, " ").trim() : null)
const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max).trimEnd()}…` : s)

/** Tên đọc được của phần tử (tên / thuật ngữ / tiêu đề, không có thì câu chính cắt ngắn); không tìm được ⇒ "". */
export const elementName = (spine: Spine, path: string): string => {
  const el = valueOf(spine, path)
  if (!el) return ""
  const own = NAME_FIELDS.map((f) => str(el[f])).find((x) => x !== null)
  if (own) return own
  const text = TEXT_FIELDS.map((f) => str(el[f])).find((x) => x !== null)
  return text ? clip(text, 60) : ""
}

const statementOf = (spine: Spine, path: string): string => {
  const el = valueOf(spine, path)
  if (!el) return ""
  const text = TEXT_FIELDS.map((f) => str(el[f])).find((x) => x !== null)
  return text ? clip(text, STATEMENT_CHARS) : ""
}

/** Phần tử làm ứng viên: mọi phần tử vị trí trừ thông tin dự án và đoạn văn giữ nguyên. */
const candidateElements = (spine: Spine): SpineElement[] => listElements(spine).filter((e) => e.path !== "project" && !e.path.startsWith("custom_sections["))

/** Phần tử được nhắc mã / tên trong chữ (chỉ phần tử có thật trong Spine). */
export const mentionedPaths = (spine: Spine, text: string): string[] =>
  [
    ...new Set(
      scanMentions(text, namedEntities(spine)).flatMap((m) => {
        const arr = ENTITY_ARRAY[m.entity]
        const path = arr ? `${String(arr)}[id=${m.id}]` : null
        return path && valueOf(spine, path) ? [path] : []
      })
    )
  ]

const runPool = async <T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> => {
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) await fn(items[next++])
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

export interface LookupOptions {
  /** Tra gần nghĩa (`vectorCandidates` gắn projectId); không có ⇒ chỉ nhắc tên + từ khoá. Lỗi ⇒ coi như rỗng. */
  vector?: (text: string) => Promise<VectorCandidate[]>
}

/** Tra ứng viên SRS cho mọi đoạn của tài liệu. */
export const lookupParagraphs = async (spine: Spine, paragraphs: readonly string[], opts: LookupOptions = {}): Promise<ParagraphHits> => {
  const hits: ParagraphHits = new Map()
  const add = (i: number, path: string, by: CandidateSource) => {
    const row = hits.get(i) ?? new Map<string, Set<CandidateSource>>()
    row.set(path, (row.get(path) ?? new Set<CandidateSource>()).add(by))
    hits.set(i, row)
  }
  const elements = candidateElements(spine)
  const exists = new Set(elements.map((e) => e.path))
  paragraphs.forEach((p, i) => {
    for (const path of mentionedPaths(spine, p)) add(i, path, "mention")
    if (p.length < KEYWORD_MIN_PARAGRAPH_CHARS || !elements.length) return
    for (const r of rankByKeywords(elements, [p]).slice(0, KEYWORD_HITS_PER_PARAGRAPH)) add(i, r.path, "keyword")
  })
  if (opts.vector && elements.length) {
    const windows: number[][] = []
    let cur: number[] = []
    let size = 0
    paragraphs.forEach((p, i) => {
      cur.push(i)
      size += p.length
      if (size >= VECTOR_WINDOW_CHARS) {
        windows.push(cur)
        cur = []
        size = 0
      }
    })
    if (cur.length) windows.push(cur)
    const vector = opts.vector
    await runPool(windows, VECTOR_CONCURRENCY, async (win) => {
      const found = await vector(win.map((i) => paragraphs[i]).join("\n")).catch(() => [] as VectorCandidate[])
      for (const v of found.filter((c) => exists.has(c.ref)).slice(0, VECTOR_HITS_PER_WINDOW)) for (const i of win) add(i, v.ref, "vector")
    })
  }
  return hits
}

/**
 * Ứng viên của các đoạn trong một lô cho prompt: mỗi phần tử một dòng, kèm tên, cách tìm ra và mã đoạn nhắc tới nó.
 * `paraId(i)` đổi chỉ số đoạn sang mã đoạn của tài liệu.
 */
export const candidatesText = (spine: Spine, hits: ParagraphHits, indices: readonly number[], paraId: (i: number) => string): string => {
  const agg = new Map<string, { paras: string[]; by: Set<CandidateSource> }>()
  for (const i of indices) {
    for (const [path, by] of hits.get(i) ?? []) {
      const row = agg.get(path) ?? { paras: [], by: new Set<CandidateSource>() }
      row.paras.push(paraId(i))
      for (const b of by) row.by.add(b)
      agg.set(path, row)
    }
  }
  const lines: string[] = []
  let used = 0
  // Nhắc tên / gần nghĩa trước từ khoá: bị cắt thì mất ứng viên yếu nhất
  const rank = (by: Set<CandidateSource>) => (by.has("mention") ? 0 : by.has("vector") ? 1 : 2)
  for (const [path, row] of [...agg.entries()].sort((a, b) => rank(a[1].by) - rank(b[1].by))) {
    const name = elementName(spine, path)
    const statement = statementOf(spine, path)
    const line = `- ${path}${name ? ` "${name}"` : ""} [${[...row.by].join(", ")}] <- ${row.paras.slice(0, 6).join(", ")}${statement && statement !== name ? `: ${statement}` : ""}`
    if (used + line.length > CANDIDATES_CHARS) break
    lines.push(line)
    used += line.length + 1
  }
  return lines.join("\n") || "(none found)"
}

/** Chỗ đã tra của một yêu cầu: phần tử nhắc tên / mã trong chữ yêu cầu + ứng viên nhắc tên / gần nghĩa của đoạn nguồn. */
export const locatedPathsFor = (spine: Spine, hits: ParagraphHits, paraIndex: number | null, text: string): string[] => {
  const out = new Set(mentionedPaths(spine, text))
  if (paraIndex !== null) for (const [path, by] of hits.get(paraIndex) ?? []) if (by.has("mention") || by.has("vector")) out.add(path)
  return [...out]
}
