/**
 * Thực thể trích được ⇄ field phẳng của `ExtractionDraft` (I-4, UC-22). FLF-171, plan §6 2C.
 * - Id phần tử: mã tài liệu chuẩn hoá (`UC01` ⇒ `UC-01`) hoặc sinh theo tiền tố (`A01`, `NFR-03`…).
 * - Feature/function của §3.2 trở đi: id suy từ số mục heading (`F-3.2`, `FR-3.2.1`), gắn với id tạm
 *   `feature:@<block>` / `function:@<block>` của template profile.
 * - Field phẳng: `<mảng>[id=<id>].<field>` hoặc `project.<field>` (cùng cú pháp path của op engine).
 */

import type { ExtractedField } from "./extraction-draft.model.js"
import type { FieldOrigin } from "./import.constants.js"
import { PROVISIONAL_SECTION } from "./section-catalog.js"
import type { HeadingMapEntry } from "./template-profile.model.js"
import { splitHeadingNumber } from "./text-similarity.js"

export interface EntityItem {
  entity: string
  /** `null` với `project`. */
  id: string | null
  value: Record<string, unknown>
  confidence: number
  field_confidence: Record<string, number>
  source_block_ids: string[]
  origin: FieldOrigin
}

export const ID_PREFIX: Readonly<Record<string, { prefix: string; pad: number }>> = {
  actors: { prefix: "A", pad: 2 },
  roles: { prefix: "R", pad: 2 },
  use_cases: { prefix: "UC-", pad: 2 },
  features: { prefix: "F-", pad: 2 },
  screens: { prefix: "SCR-", pad: 2 },
  permissions: { prefix: "P", pad: 3 },
  entities: { prefix: "E", pad: 2 },
  functions: { prefix: "FR-", pad: 2 },
  nfrs: { prefix: "NFR-", pad: 2 },
  business_rules: { prefix: "BR-", pad: 2 },
  common_requirements: { prefix: "COM-", pad: 2 },
  messages: { prefix: "MSG-", pad: 2 },
  other_requirements: { prefix: "OR-", pad: 2 },
  glossary: { prefix: "G", pad: 2 }
}

/** `UC01`, `uc_01`, `UC 01` ⇒ `UC-01`; khoá khác giữ nguyên (bỏ khoảng trắng thừa). */
export const normalizeKey = (key: string): string => {
  const k = key.trim()
  const m = /^([A-Za-z]{1,5})[-_ ]?(\d+(?:\.\d+)*)$/.exec(k)
  return m ? `${m[1].toUpperCase()}-${m[2]}` : k.replace(/\s+/g, " ")
}

/** Cấp id mới không trùng id đã có của từng mảng. */
export class IdAllocator {
  private readonly used = new Map<string, Set<string>>()
  private readonly counters = new Map<string, number>()

  constructor(existing: Record<string, Iterable<string>> = {}) {
    for (const [entity, ids] of Object.entries(existing)) for (const id of ids) this.reserve(entity, id)
  }

  reserve(entity: string, id: string): void {
    const set = this.used.get(entity) ?? new Set<string>()
    set.add(id)
    this.used.set(entity, set)
  }

  has(entity: string, id: string): boolean {
    return this.used.get(entity)?.has(id) ?? false
  }

  next(entity: string): string {
    const def = ID_PREFIX[entity] ?? { prefix: `${entity.slice(0, 3).toUpperCase()}-`, pad: 2 }
    let n = this.counters.get(entity) ?? 0
    let id: string
    do id = `${def.prefix}${String(++n).padStart(def.pad, "0")}`
    while (this.has(entity, id))
    this.counters.set(entity, n)
    this.reserve(entity, id)
    return id
  }
}

// ─── feature/function tạm ────────────────────────────────────────

export interface ProvisionalEntity {
  section: string
  entity: "features" | "functions"
  id: string
  name: string
  /** Function: feature cha (id thật). */
  feature_id: string | null
  block_id: string
  confidence: number
}

/** Id thật cho mọi section tạm, theo thứ tự tài liệu (function thuộc feature đứng trước gần nhất). */
export const resolveProvisional = (headingMap: HeadingMapEntry[]): Map<string, ProvisionalEntity> => {
  const out = new Map<string, ProvisionalEntity>()
  const alloc = new IdAllocator()
  let feature: ProvisionalEntity | null = null
  for (const h of headingMap) {
    const m = PROVISIONAL_SECTION.exec(h.section_id)
    if (!m || out.has(h.section_id)) continue
    const { number, title } = splitHeadingNumber(h.heading_text)
    if (m[1] === "feature") {
      const wanted = number ? `F-${number}` : null
      const id = wanted && !alloc.has("features", wanted) ? wanted : alloc.next("features")
      alloc.reserve("features", id)
      feature = { section: h.section_id, entity: "features", id, name: title, feature_id: null, block_id: m[2], confidence: h.confidence }
      out.set(h.section_id, feature)
    } else {
      const wanted = number ? `FR-${number}` : null
      const id = wanted && !alloc.has("functions", wanted) ? wanted : alloc.next("functions")
      alloc.reserve("functions", id)
      out.set(h.section_id, { section: h.section_id, entity: "functions", id, name: title, feature_id: feature?.id ?? null, block_id: m[2], confidence: h.confidence })
    }
  }
  return out
}

/** `feature:@B0042` ⇒ `feature:F-3.2`; section khác giữ nguyên. */
export const realSectionId = (sectionId: string, provisional: Map<string, ProvisionalEntity>): string => {
  const p = provisional.get(sectionId)
  return p ? `${p.entity === "features" ? "feature" : "function"}:${p.id}` : sectionId
}

// ─── field phẳng ─────────────────────────────────────────────────

export const fieldPath = (entity: string, id: string | null, field: string): string =>
  entity === "project" || id === null ? `project.${field}` : `${entity}[id=${id}].${field}`

const PATH_RE = /^(?:project\.(\w+)|(\w+)\[id=([^\]]+)\]\.(\w+))$/

export const parseFieldPath = (path: string): { entity: string; id: string | null; field: string } | null => {
  const m = PATH_RE.exec(path)
  if (!m) return null
  return m[1] ? { entity: "project", id: null, field: m[1] } : { entity: m[2], id: m[3], field: m[4] }
}

export const flattenItem = (item: EntityItem): ExtractedField[] =>
  Object.entries(item.value)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([field, value]) => ({
      path: fieldPath(item.entity, item.id, field),
      value,
      confidence: Math.min(1, Math.max(0, item.field_confidence[field] ?? item.confidence)),
      source_block_ids: item.source_block_ids,
      origin: item.origin,
      confirmed: false
    }))

/** Gộp field phẳng lại thành thực thể; `edited_value` (UC-22) thắng `value`. */
/**
 * Field là danh sách tham chiếu (quan hệ): nhiều nguồn (bảng, chữ, ảnh diagram — phase 5) cùng nói về một phần tử thì
 * gộp hợp, không ghi đè — vd bảng UC chỉ ghi "Learner", diagram còn nối thêm "Guest".
 */
export const REF_LIST_FIELDS: ReadonlySet<string> = new Set(["actor_ids", "includes", "extends", "relations", "flow_to"])

/** Giá trị mới của field khi đã có giá trị cũ: danh sách tham chiếu ⇒ hợp (giữ thứ tự), còn lại ⇒ giá trị mới. */
export const mergeFieldValue = (field: string, prev: unknown, next: unknown): unknown =>
  REF_LIST_FIELDS.has(field) && Array.isArray(prev) && Array.isArray(next) ? [...new Set([...prev, ...next])] : next

export const collectEntities = (
  fields: (ExtractedField & { section_id?: string })[]
): Map<string, { entity: string; id: string | null; value: Record<string, unknown>; source_block_ids: Set<string>; sections: Set<string> }> => {
  const out = new Map<string, { entity: string; id: string | null; value: Record<string, unknown>; source_block_ids: Set<string>; sections: Set<string> }>()
  for (const f of fields) {
    const p = parseFieldPath(f.path)
    if (!p) continue
    const key = `${p.entity}|${p.id ?? ""}`
    const cur = out.get(key) ?? { entity: p.entity, id: p.id, value: {}, source_block_ids: new Set<string>(), sections: new Set<string>() }
    const next = f.edited_value !== undefined ? f.edited_value : f.value
    cur.value[p.field] = p.field in cur.value ? mergeFieldValue(p.field, cur.value[p.field], next) : next
    for (const b of f.source_block_ids) cur.source_block_ids.add(b)
    if (f.section_id) cur.sections.add(f.section_id)
    out.set(key, cur)
  }
  return out
}
