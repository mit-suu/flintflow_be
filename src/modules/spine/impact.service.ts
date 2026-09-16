/**
 * impact.service.ts
 * ─────────────────────────────────────────────────────────────────
 * Impact query trên đồ thị khoá (srs-spine.md §9, Phases §2.2): "đổi field này thì phần nào của SRS
 * bị kéo theo?". Hai nguồn, không đoán thêm:
 *   - `FIELD_SECTION_MAP` (§4, qua `sectionsOfPath` của T09) → section theo 3 cột Sở hữu / Đọc / Suy dẫn.
 *   - `reference_fields[]` (§4.1, qua `iterateReferences` của T08) → khoá đang trỏ tới phần tử bị đụng.
 *
 * Diagram: khi có Spine "sau khi áp lô" (`after`) thì so `source_hash` trước/sau — đúng danh sách hình
 * SẼ phải vẽ lại, không phải danh sách hình "có thể liên quan". Không có `after` (impact query thuần trên
 * path) thì lấy hình có `section` nằm trong cột Suy dẫn.
 *
 * Giới hạn đã biết (srs-spine §4.1, ghi ra UI ở T16): impact CHỈ bắt quan hệ khoá. Đổi `actors[].name`
 * không phát hiện được tên actor đó nằm trong văn xuôi `use_cases[].description` — đó là việc của
 * S-8.4 Consistency Pass. Vì vậy kết quả là **cảnh báo heuristic**, không phải chứng minh.
 */

import type { Referrer } from "./op.types.js"
import { iterateReferences } from "./reference-fields.js"
import { sectionsOfPath, type ChangeHint } from "./section-registry.js"
import { computeSourceHash } from "./source-hash.js"
import { parsePath, PathError } from "./path-resolver.js"
import type { DiagramKind, Spine } from "./spine.types.js"

/** Quan hệ giữa field đổi và section, theo 3 cột bảng §4. */
export type SectionRelation = "owner" | "reads" | "derived"

export interface ImpactSection {
  id: string
  relation: SectionRelation
}

export interface Impact {
  /** Path đã chuẩn hoá của các field bị đụng (đầu vào, bỏ trùng). */
  fields: string[]
  /** Section bị kéo theo; một section chỉ xuất hiện một lần, quan hệ mạnh nhất thắng. */
  sections: ImpactSection[]
  /** Kind diagram phải vẽ lại. */
  diagrams: DiagramKind[]
  /** Khoá đang trỏ tới phần tử bị đụng — để user tự quyết khi xoá. */
  referrers: Referrer[]
}

export interface ImpactOptions {
  /** `before`/`value` của change, để tra được phần tử đã bị xoá khỏi Spine hiện tại. */
  hints?: Readonly<Record<string, ChangeHint>>
  /** Spine sau khi áp lô — có thì diagram tính bằng so `source_hash`. */
  after?: Spine
}

/** owner > reads > derived: section vừa sở hữu vừa đọc field thì hiện là `owner`. */
const RELATION_RANK: Readonly<Record<SectionRelation, number>> = { owner: 0, reads: 1, derived: 2 }

const EMPTY: Impact = Object.freeze({ fields: [], sections: [], diagrams: [], referrers: [] })

/** `actors[id=A01].name` → `A01`; path không trỏ phần tử có id ⇒ null. */
const elementIdOf = (path: string): string | null => {
  try {
    const head = parsePath(path)[0]
    if (head.selector?.kind !== "match") return null
    return head.selector.pairs.find(([key]) => key === "id")?.[1] ?? null
  } catch (err) {
    if (err instanceof PathError) return null
    throw err
  }
}

/** Khoá đang trỏ tới bất kỳ id nào trong `ids` — `reference_fields[]` §4.1, không chép tay. */
export const referrersOf = (spine: Spine, ids: ReadonlySet<string>): Referrer[] => {
  if (ids.size === 0) return []
  const out = new Map<string, Referrer>()
  for (const hit of iterateReferences(spine)) {
    if (!ids.has(hit.targetId)) continue
    // Chính phần tử đang đổi trỏ tới chính nó không phải "bị tham chiếu"
    if (hit.ownerPath.endsWith(`[id=${hit.targetId}]`)) continue
    out.set(hit.refPath, { path: hit.refPath, id: hit.targetId })
  }
  return [...out.values()]
}

/** Hình có `source_hash` lệch giữa `before` và `after` — đúng những hình sẽ phải vẽ lại. */
export const diagramsToRerender = (before: Spine, after: Spine): DiagramKind[] => {
  const kinds = new Set<DiagramKind>()
  for (const diagram of after.diagrams) {
    const previous = before.diagrams.find((d) => d.id === diagram.id)
    if (!previous) {
      kinds.add(diagram.kind)
      continue
    }
    if (computeSourceHash(before, previous) !== computeSourceHash(after, diagram)) kinds.add(diagram.kind)
  }
  // Hình bị xoá khỏi lô cũng là thay đổi hình của kind đó
  for (const diagram of before.diagrams) {
    if (!after.diagrams.some((d) => d.id === diagram.id)) kinds.add(diagram.kind)
  }
  return [...kinds]
}

/** Section suy dẫn nào là section của một diagram ⇒ kind của diagram đó. */
const diagramKindsOfSections = (spine: Spine, sectionIds: readonly string[]): DiagramKind[] => {
  const kinds = new Set<DiagramKind>()
  for (const id of sectionIds) {
    for (const diagram of spine.diagrams) if (diagram.section === id) kinds.add(diagram.kind)
  }
  return [...kinds]
}

/**
 * Phạm vi ảnh hưởng của việc đổi các field ở `paths`.
 * Hàm thuần — không DB, không ghi gì; dùng chung cho preview (T17), UI cảnh báo (T16) và hoà giải.
 */
export const impactOf = (spine: Spine, paths: readonly string[], options: ImpactOptions = {}): Impact => {
  if (paths.length === 0) return { ...EMPTY, fields: [], sections: [], diagrams: [], referrers: [] }

  const fields = [...new Set(paths)]
  const sections = new Map<string, SectionRelation>()
  const derivedSections: string[] = []
  const touchedIds = new Set<string>()

  for (const path of fields) {
    const impact = sectionsOfPath(spine, path, options.hints?.[path] ?? {})
    for (const relation of ["owner", "reads", "derived"] as const) {
      for (const id of impact[relation]) {
        const current = sections.get(id)
        if (current === undefined || RELATION_RANK[relation] < RELATION_RANK[current]) sections.set(id, relation)
      }
    }
    derivedSections.push(...impact.derived)

    const id = elementIdOf(path)
    if (id !== null) touchedIds.add(id)
  }

  return {
    fields,
    sections: [...sections].map(([id, relation]) => ({ id, relation })),
    diagrams: options.after ? diagramsToRerender(spine, options.after) : diagramKindsOfSections(spine, derivedSections),
    referrers: referrersOf(spine, touchedIds)
  }
}

/** Lô op → impact; `changes` là diff đã tính (preview/apply), `after` để lấy đúng diagram phải vẽ lại. */
export const impactOfChanges = (
  spine: Spine,
  changes: readonly { path: string; before: unknown; value: unknown }[],
  after?: Spine
): Impact => {
  const hints: Record<string, ChangeHint> = {}
  for (const change of changes) hints[change.path] = { before: change.before, value: change.value }
  return impactOf(spine, changes.map((c) => c.path), { hints, ...(after ? { after } : {}) })
}
