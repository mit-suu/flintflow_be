/**
 * So hai danh sách block theo thứ tự tài liệu (re-upload UC-24 nút 1.4, so sánh version UC-55). FLF-171, plan §6 2D.
 * Khớp block: bookmark neo (`block_id`) → `para_id` → LCS trên `text_hash` của phần còn lại → (FLF-186, file render không
 * có neo) block trùng text ngoài dãy LCS ⇒ `moved`; block còn lẻ giữa cùng hai block đã khớp ghép theo độ giống từ
 * (≥ `MODIFIED_SIMILARITY`) ⇒ `modified`.
 * Cặp khớp khác text ⇒ `modified`; cặp khớp đổi thứ tự (ngoài dãy con tăng dài nhất) ⇒ `moved`;
 * block cũ không khớp ⇒ `removed`; block mới không khớp ⇒ `added` (`block_id = null` nếu chưa có id).
 * FLF-447: block mang `section` / `kind` / `rows` (từ `toDiffBlocks`) ⇒ entry ghi mục chứa nó + loại; hai bảng còn lẻ giữa cùng hai block
 * đã khớp ghép theo vị trí; bảng khớp mà khác chữ ⇒ diff theo hàng (`table-row-diff.ts`), chỉ đổi thứ tự hàng theo mã ⇒ không là thay đổi;
 * `sections` đếm block không đổi theo mục (FE vẽ `⋯ n đoạn`, không trả chữ).
 */

import type { OoxmlBlock } from "../docx-ooxml/index.js"
import type { BlockDiffEntry, DiffBlockKind } from "../import/reupload-diff.model.js"
import { diffTableRows, rowDiffable } from "./table-row-diff.js"

export interface DiffBlock {
  /** `null` với block của file mới chưa mang bookmark FlintFlow. */
  block_id: string | null
  para_id?: string | null
  text: string
  text_hash: string
  /** Loại block cho FE (FLF-447); thiếu ⇒ entry không mang `kind` / `section` (giữ shape cũ). */
  kind?: DiffBlockKind
  /** Chỉ với bảng: chữ từng ô theo hàng. */
  rows?: string[][] | null
  /** Tiêu đề mục chứa block (heading: chính nó); "" = trước heading đầu. */
  section?: string
  /** Khoá mục = cả đường heading (hai mục trùng tên ở hai chỗ khác nhau không bị gộp). */
  section_key?: string
}

/** Số block không đổi của một mục (theo thứ tự tài liệu mới). */
export interface SectionStat {
  title: string
  /** Khoá mục (đường heading); thiếu ở bản ghi cũ. */
  key?: string
  unchanged: number
}

/** Block đọc từ file ⇒ block để diff, kèm mục chứa nó + loại + hàng của bảng. */
export const toDiffBlocks = (blocks: readonly OoxmlBlock[]): DiffBlock[] =>
  blocks.map((b) => {
    const kind: DiffBlockKind = b.kind === "heading" ? "heading" : b.kind === "table" ? "table" : b.image_ref ? "image" : "paragraph"
    return {
      block_id: null,
      para_id: b.para_id,
      text: b.text,
      text_hash: b.text_hash,
      kind,
      rows: kind === "table" ? b.rows : null,
      section: kind === "heading" ? b.text.trim() : (b.heading_path[b.heading_path.length - 1] ?? "").trim(),
      section_key: (kind === "heading" ? [...b.heading_path, b.text] : b.heading_path).map((h) => h.trim()).join(" > ")
    }
  })

export interface BlockDiffSummary {
  added: number
  removed: number
  modified: number
  moved: number
}

const lcsPairs = (a: string[], b: string[]): [number, number][] => {
  const n = a.length
  const m = b.length
  if (!n || !m) return []
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out: [number, number][] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push([i, j])
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++
    else j++
  }
  return out
}

/** Chỉ số (trong `seq`) thuộc một dãy con tăng dài nhất — phần tử còn lại coi là bị di chuyển. */
const longestIncreasing = (seq: number[]): Set<number> => {
  const tails: number[] = []
  const prev = new Array<number>(seq.length).fill(-1)
  for (let i = 0; i < seq.length; i++) {
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (seq[tails[mid]] < seq[i]) lo = mid + 1
      else hi = mid
    }
    if (lo > 0) prev[i] = tails[lo - 1]
    tails[lo] = i
  }
  const keep = new Set<number>()
  for (let k = tails.length ? tails[tails.length - 1] : -1; k >= 0; k = prev[k]) keep.add(k)
  return keep
}

/** Ngưỡng giống từ (Jaccard trên tập từ) để coi hai block không neo là một block bị sửa. */
export const MODIFIED_SIMILARITY = 0.5

const wordSet = (s: string): Set<string> => new Set(s.toLowerCase().split(/\s+/).filter(Boolean))

const similarity = (a: string, b: string): number => {
  const A = wordSet(a)
  const B = wordSet(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const t of A) if (B.has(t)) inter++
  return inter / (A.size + B.size - inter)
}

/**
 * Một cặp theo thứ tự tài liệu mới (khối bị xoá chen vào đúng chỗ): `before` / `after` là chỉ số trong hai danh sách đầu vào.
 * `unchanged` gồm cả bảng chỉ đổi thứ tự hàng. FLF-495: bên dùng muốn vẽ cả khối không đổi (không chỉ entry đổi).
 */
export interface AlignedPair {
  before: number | null
  after: number | null
  change: "unchanged" | "added" | "removed" | "modified" | "moved"
}

/** `diffBlockLists` kèm `pairs` (cả khối không đổi, đúng thứ tự tài liệu) — FLF-495. */
export const alignBlockLists = (
  before: DiffBlock[],
  after: DiffBlock[]
): { blocks: BlockDiffEntry[]; summary: BlockDiffSummary; sections: SectionStat[]; pairs: AlignedPair[] } => {
  const matchOfAfter = new Map<number, number>()
  const usedBefore = new Set<number>()
  const beforeById = new Map<string, number>()
  before.forEach((b, i) => b.block_id && beforeById.set(b.block_id, i))
  const beforeByPara = new Map<string, number>()
  before.forEach((b, i) => b.para_id && !beforeByPara.has(b.para_id) && beforeByPara.set(b.para_id, i))

  after.forEach((a, j) => {
    const byId = a.block_id ? beforeById.get(a.block_id) : undefined
    const byPara = a.para_id ? beforeByPara.get(a.para_id) : undefined
    const i = byId ?? byPara
    if (i !== undefined && !usedBefore.has(i)) {
      matchOfAfter.set(j, i)
      usedBefore.add(i)
    }
  })
  // Phần còn lại: LCS theo text_hash
  const restBefore = before.map((_, i) => i).filter((i) => !usedBefore.has(i))
  const restAfter = after.map((_, j) => j).filter((j) => !matchOfAfter.has(j))
  for (const [x, y] of lcsPairs(restBefore.map((i) => before[i].text_hash), restAfter.map((j) => after[j].text_hash))) {
    matchOfAfter.set(restAfter[y], restBefore[x])
    usedBefore.add(restBefore[x])
  }

  // Block trùng text nằm ngoài dãy LCS (bị di chuyển, file không có neo) ⇒ khớp chính xác, sẽ thành `moved`
  after.forEach((a, j) => {
    if (matchOfAfter.has(j)) return
    const i = before.findIndex((x, k) => !usedBefore.has(k) && x.text_hash === a.text_hash)
    if (i >= 0) {
      matchOfAfter.set(j, i)
      usedBefore.add(i)
    }
  })

  // Block lẻ giữa cùng hai block đã khớp ⇒ ghép theo độ giống từ (sửa chữ trong file không có neo)
  after.forEach((a, j) => {
    if (matchOfAfter.has(j)) return
    let lo = -1
    let hi = before.length
    for (const [jj, ii] of matchOfAfter) {
      if (jj < j && ii > lo) lo = ii
      if (jj > j && ii < hi) hi = ii
    }
    let best = -1
    let bestScore = MODIFIED_SIMILARITY
    for (let i = lo + 1; i < hi; i++) {
      if (usedBefore.has(i)) continue
      // Hai bảng còn lẻ giữa cùng hai block đã khớp là một bảng bị sửa (thêm nhiều hàng làm độ giống từ tụt dưới ngưỡng)
      const tables = a.kind === "table" && before[i].kind === "table"
      const score = Math.max(similarity(before[i].text, a.text), tables ? MODIFIED_SIMILARITY : 0)
      if (score >= bestScore) {
        best = i
        bestScore = score
      }
    }
    if (best >= 0) {
      matchOfAfter.set(j, best)
      usedBefore.add(best)
    }
  })

  const matchedAfter = [...matchOfAfter.keys()].sort((x, y) => x - y)
  const inOrder = longestIncreasing(matchedAfter.map((j) => matchOfAfter.get(j)!))
  const moved = new Set(matchedAfter.filter((_, k) => !inOrder.has(k)))

  /** Mục + loại của entry — chỉ khi block mang thông tin đó (caller cũ không truyền ⇒ shape cũ). */
  const meta = (x: DiffBlock): Pick<BlockDiffEntry, "section" | "section_key" | "kind"> =>
    x.section !== undefined ? { section: x.section, ...(x.section_key !== undefined ? { section_key: x.section_key } : {}), ...(x.kind ? { kind: x.kind } : {}) } : {}
  /** Khoá mục ⇒ { tiêu đề, số khối không đổi }, theo thứ tự xuất hiện. */
  const stats = new Map<string, { title: string; unchanged: number }>()
  const keyOf = (x: { section?: string; section_key?: string }): string => x.section_key ?? x.section ?? ""
  const note = (x: { section?: string; section_key?: string }): void => {
    if (x.section !== undefined && !stats.has(keyOf(x))) stats.set(keyOf(x), { title: x.section, unchanged: 0 })
  }
  const unchanged = (x: DiffBlock): void => {
    if (x.section === undefined) return
    note(x)
    stats.get(keyOf(x))!.unchanged++
  }
  for (const x of after) note(x)

  const entries: BlockDiffEntry[] = []
  const pairs: AlignedPair[] = []
  /** Khối bị xoá chen vào đúng chỗ trong tài liệu: trước khối mới đầu tiên ghép với khối cũ đứng sau nó. */
  const emittedRemoved = new Set<number>()
  const flushRemoved = (upTo: number): void => {
    for (let k = 0; k < upTo; k++) {
      if (usedBefore.has(k) || emittedRemoved.has(k)) continue
      emittedRemoved.add(k)
      entries.push({ block_id: before[k].block_id, change: "removed", before: before[k].text, ...meta(before[k]) })
      pairs.push({ before: k, after: null, change: "removed" })
    }
  }
  after.forEach((a, j) => {
    const i = matchOfAfter.get(j)
    if (i !== undefined && !moved.has(j)) flushRemoved(i)
    if (i === undefined) {
      entries.push({ block_id: a.block_id, change: "added", after: a.text, ...meta(a) })
      pairs.push({ before: null, after: j, change: "added" })
      return
    }
    const b = before[i]
    if (moved.has(j)) {
      entries.push({ block_id: b.block_id, change: "moved", before: b.text, after: a.text, ...meta(a) })
      pairs.push({ before: i, after: j, change: "moved" })
    } else if (b.text_hash !== a.text_hash) {
      if (a.kind === "table" && b.kind === "table" && a.rows?.length && b.rows?.length && rowDiffable(a.rows, b.rows)) {
        const table = diffTableRows(b.rows, a.rows)
        // Chỉ đổi thứ tự hàng theo cột mã ⇒ không phải thay đổi
        if (!table) {
          pairs.push({ before: i, after: j, change: "unchanged" })
          return unchanged(a)
        }
        pairs.push({ before: i, after: j, change: "modified" })
        entries.push({ block_id: b.block_id, change: "modified", before: b.text, after: a.text, ...meta(a), table })
      } else {
        pairs.push({ before: i, after: j, change: "modified" })
        entries.push({ block_id: b.block_id, change: "modified", before: b.text, after: a.text, ...meta(a) })
      }
    } else {
      pairs.push({ before: i, after: j, change: "unchanged" })
      unchanged(a)
    }
  })
  flushRemoved(before.length)
  for (const e of entries) note(e)
  const count = (c: BlockDiffEntry["change"]): number => entries.filter((e) => e.change === c).length
  return {
    blocks: entries,
    summary: { added: count("added"), removed: count("removed"), modified: count("modified"), moved: count("moved") },
    sections: [...stats].map(([key, s]) => ({ title: s.title, key, unchanged: s.unchanged })),
    pairs
  }
}

export const diffBlockLists = (before: DiffBlock[], after: DiffBlock[]): { blocks: BlockDiffEntry[]; summary: BlockDiffSummary; sections: SectionStat[] } => {
  const { pairs: _pairs, ...result } = alignBlockLists(before, after)
  return result
}
