/**
 * Thực thể trích được ⇄ field phẳng của `ExtractionDraft` (I-4, UC-22). FLF-171, plan §6 2C.
 * - Id phần tử: mã tài liệu chuẩn hoá (`UC01` ⇒ `UC-01`) hoặc sinh theo tiền tố (`A01`, `NFR-03`…).
 * - Feature/function của §3.2 trở đi: id suy từ số mục heading (`F-3.2`, `FR-3.2.1`), gắn với id tạm
 *   `feature:@<block>` / `function:@<block>` của template profile.
 * - Field phẳng: `<mảng>[id=<id>].<field>` hoặc `project.<field>` (cùng cú pháp path của op engine).
 */

import type { ExtractedField } from "./extraction-draft.model.js"
import { formatFor, nextIdIn } from "../spine/id-allocator.js"
import type { FieldOrigin } from "./import.constants.js"
import { PROVISIONAL_SECTION } from "./section-catalog.js"
import type { HeadingMapEntry } from "./template-profile.model.js"
import { foldText, splitHeadingNumber } from "./text-similarity.js"

export interface EntityItem {
  entity: string
  /** `null` với `project`. */
  id: string | null
  value: Record<string, unknown>
  confidence: number
  field_confidence: Record<string, number>
  source_block_ids: string[]
  origin: FieldOrigin
  /** Nguồn riêng của field khác nguồn item — phần ảnh bù vào phần tử của chữ / bảng vẫn là `vision` (FLF-252). */
  field_origin?: Record<string, FieldOrigin>
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
  glossary: { prefix: "G", pad: 2 },
  deployment_nodes: { prefix: "DN", pad: 2 }
}

/**
 * FLF-361: mã phần tử ghi vào Spine **đúng như tài liệu** (chỉ bỏ khoảng trắng hai đầu / thừa) — `UC01` giữ `UC01`, `A01`
 * giữ `A01`. So khớp / chống trùng dùng `idKey` (bỏ qua `-`, `_`, khoảng trắng, số 0 đầu).
 */
export const keepKey = (key: string): string => key.trim().replace(/\s+/g, " ")

/** `UC01`, `uc_01`, `UC 01` ⇒ `UC-01`; khoá khác giữ nguyên (bỏ khoảng trắng thừa). Không dùng cho id Spine nữa (FLF-361). */
export const normalizeKey = (key: string): string => {
  const k = key.trim()
  const m = /^([A-Za-z]{1,5})[-_ ]?(\d+(?:\.\d+)*)$/.exec(k)
  return m ? `${m[1].toUpperCase()}-${m[2]}` : k.replace(/\s+/g, " ")
}

/**
 * Khoá so tên khi ghép cùng một phần tử giữa các nguồn (bảng, chữ, heading, ảnh — FLF-251): bỏ số mục đầu, dấu,
 * hoa/thường, ký tự lạ ⇒ "3.6.2 Send Reminder" = "send reminder", "Log-in" = "log in".
 */
export const nameKey = (name: string): string => foldText(splitHeadingNumber(name).title)

const nameOf = (value: Record<string, unknown>): string | null =>
  typeof value.name === "string" ? value.name : typeof value.term === "string" ? value.term : null

/** Id của phần tử cùng loại đã biết có tên trùng (sau chuẩn hoá); không có ⇒ `null`. */
export const findKnownId = (known: readonly EntityItem[], entity: string, name: unknown): string | null => {
  if (typeof name !== "string" || !nameKey(name)) return null
  const key = nameKey(name)
  const hit = known.find((k) => {
    const n = k.entity === entity && k.id ? nameOf(k.value) : null
    return n !== null && nameKey(n) === key
  })
  return hit?.id ?? null
}

/** Số nhiều tiếng Anh thường gặp ⇒ số ít: categories ⇒ category, analyses ⇒ analysis, files ⇒ file (từ ≤ 3 chữ giữ nguyên). */
const singular = (w: string): string => {
  if (w.length <= 3) return w
  if (w.endsWith("ies")) return `${w.slice(0, -3)}y`
  if (w.endsWith("yses")) return `${w.slice(0, -4)}ysis`
  if (/(ss|sh|ch|x)es$/.test(w)) return w.slice(0, -2)
  if (w.endsWith("s") && !/(ss|us|is)$/.test(w)) return w.slice(0, -1)
  return w
}

/**
 * Khoá so tên khác quy ước đặt tên (FLF-252): ERD vẽ lớp "SubscriptionPlan" / "PrAnalysis", bảng ghi bảng dữ liệu
 * "subscription_plans" / "pr_analyses" ⇒ cùng "subscriptionplan" / "pranalysis" (tách camelCase, bỏ dấu, về số ít, bỏ khoảng trắng).
 */
export const compactKey = (name: string): string =>
  nameKey(name.replace(/([a-z0-9])([A-Z])/g, "$1 $2"))
    .split(" ")
    .map(singular)
    .join("")

/** Id của phần tử cùng loại DUY NHẤT có `compactKey` trùng (khác quy ước đặt tên); không có / nhiều phần tử ⇒ `null`. */
export const findKnownCompact = (known: readonly EntityItem[], entity: string, name: unknown): string | null => {
  const key = typeof name === "string" ? compactKey(name) : ""
  if (!key) return null
  const ids = new Set<string>()
  for (const k of known) {
    const n = k.entity === entity && k.id ? nameOf(k.value) : null
    if (n !== null && compactKey(n) === key) ids.add(k.id!)
  }
  return ids.size === 1 ? [...ids][0] : null
}

/**
 * Khoá so mã phần tử (FLF-252): bỏ dấu nối / gạch dưới / khoảng trắng và số 0 đứng đầu, không phân biệt hoa thường ⇒
 * "A01" = "A-01" = "a1", "UC01" = "UC-01". Id cấp tự động ("A01", "E01") không cùng dạng `normalizeKey` ("A-01").
 */
export const idKey = (id: string): string =>
  id
    .trim()
    .toUpperCase()
    .replace(/[-_\s]+/g, "")
    .replace(/(^|\D)0+(?=\d)/g, "$1")

/** Id đã biết cùng loại có mã trùng (so theo `idKey`); không có ⇒ `null`. */
export const findKnownKey = (known: readonly EntityItem[], entity: string, key: string): string | null => {
  const k = idKey(key)
  return known.find((x) => x.entity === entity && x.id !== null && idKey(x.id) === k)?.id ?? null
}

/**
 * Id của phần tử model trả về (FLF-252):
 * - khoá trùng mã đã biết (so lỏng) ⇒ mã đó. Model chép đúng "A01" từ known_keys nhưng `normalizeKey` đổi thành "A-01" ⇒
 *   trước đây thành phần tử thứ hai: tác nhân của bảng bị nhân đôi khi sơ đồ ngữ cảnh / use case vẽ lại, thực thể khi ERD vẽ lại;
 * - khoá chỉ là tên chép lại ("LimCallLog") ⇒ coi như không có khoá;
 * - ảnh hiếm khi ghi mã ⇒ tên trùng phần tử đã biết thắng khoá lạ (model tự đặt); chữ thì mã tài liệu thắng. Tên so cả
 *   khác quy ước đặt tên khi chỉ một phần tử khớp ("SubscriptionPlan" của ERD = "subscription_plans" của bảng);
 * - không khớp gì ⇒ khoá như tài liệu (FLF-361, không đổi `UC01` thành `UC-01`); không có khoá ⇒ `null` (cấp mới).
 */
export const aiItemId = (known: readonly EntityItem[], entity: string, key: string | null, name: unknown, fromImage = false): string | null => {
  const code = key?.trim() && !(typeof name === "string" && nameKey(key) === nameKey(name)) ? key.trim() : null
  const sameKey = code ? findKnownKey(known, entity, code) : null
  if (sameKey) return sameKey
  const sameName = findKnownId(known, entity, name) ?? findKnownCompact(known, entity, name)
  if (sameName && (fromImage || !code)) return sameName
  return code ? keepKey(code) : null
}

/**
 * Nguồn id cho `itemsFromAi`: `IdAllocator` thật lúc ghép section, hoặc nguồn nháp không cấp mã (FLF-392 — dựng known_keys
 * lúc đọc song song; phần tử AI mới không có id nên không vào prompt).
 */
export type IdSource = Pick<IdAllocator, "next" | "reserve">

/**
 * Cấp id mới không trùng id đã có của từng mảng — so theo `idKey`: đã có "A-01" thì không cấp "A01". FLF-361: khuôn theo
 * id đang có (`formatFor`, như CR — FLF-307): tài liệu đánh `UC01` ⇒ id mới `UC03`, không `UC-03` lạc khuôn.
 */
export class IdAllocator {
  private readonly used = new Map<string, Set<string>>()
  private readonly raw = new Map<string, string[]>()

  constructor(existing: Record<string, Iterable<string>> = {}) {
    for (const [entity, ids] of Object.entries(existing)) for (const id of ids) this.reserve(entity, id)
  }

  reserve(entity: string, id: string): void {
    const set = this.used.get(entity) ?? new Set<string>()
    set.add(idKey(id))
    this.used.set(entity, set)
    this.raw.set(entity, [...(this.raw.get(entity) ?? []), id])
  }

  has(entity: string, id: string): boolean {
    return this.used.get(entity)?.has(idKey(id)) ?? false
  }

  next(entity: string): string {
    const def = ID_PREFIX[entity] ?? { prefix: `${entity.slice(0, 3).toUpperCase()}-`, pad: 2 }
    // Chỉ suy khuôn từ mã dạng `<chữ><số>` (`UC01`, `UC-01`) — id theo số mục (`FR-3.2.2`) không phải khuôn đánh số
    const existing = (this.raw.get(entity) ?? []).filter((id) => /^[A-Za-z]{1,5}[-_]?\d+$/.test(id))
    const format = formatFor(existing, { prefix: def.prefix, width: def.pad })
    let id = nextIdIn(existing, format)
    while (this.has(entity, id)) {
      existing.push(id)
      id = nextIdIn(existing, format)
    }
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
      origin: item.field_origin?.[field] ?? item.origin,
      confirmed: false
    }))

/** Gộp field phẳng lại thành thực thể; `edited_value` (UC-22) thắng `value`. */
/**
 * Field là danh sách tham chiếu (quan hệ): nhiều nguồn (bảng, chữ, ảnh diagram — phase 5) cùng nói về một phần tử thì
 * gộp hợp, không ghi đè — vd bảng UC chỉ ghi "Learner", diagram còn nối thêm "Guest".
 */
export const REF_LIST_FIELDS: ReadonlySet<string> = new Set(["actor_ids", "includes", "extends", "relations", "flow_to"])

/** Giá trị mới của field khi đã có giá trị cũ: danh sách tham chiếu ⇒ hợp (giữ thứ tự), còn lại ⇒ giá trị mới. */
export const mergeFieldValue = (field: string, prev: unknown, next: unknown): unknown => {
  if (!REF_LIST_FIELDS.has(field) || !Array.isArray(prev) || !Array.isArray(next)) return next
  if (field !== "flow_to") return [...new Set([...prev, ...next])]
  // `flow_to`: phần tử là chuỗi hoặc { to, trigger?, guard? } — cùng màn đích thì gộp, giữ cạnh có nhãn
  const byTo = new Map<string, unknown>()
  for (const x of [...prev, ...next]) {
    const key = String(refTarget(x))
    const had = byTo.get(key)
    byTo.set(key, had === undefined || typeof had === "string" ? x : typeof x === "string" ? had : { ...x, ...had })
  }
  return [...byTo.values()]
}

/** Đích của một phần tử trong danh sách tham chiếu: chuỗi, hoặc `to` của object (`flow_to`). */
export const refTarget = (ref: unknown): unknown => (typeof ref === "object" && ref !== null && "to" in ref ? (ref as { to: unknown }).to : ref)

/**
 * Thứ tự phần tử theo nơi chữ / bảng định nghĩa nó (field không đọc từ ảnh đầu tiên); phần tử chỉ có trong ảnh xếp sau
 * hết, theo nơi ảnh nhắc đầu tiên (FLF-252, FLF-411 #7): quan hệ đọc từ sơ đồ use case ở 2.2.1 không còn kéo vài use case lên trước cả bảng 2.2.2 khi in.
 */
export const collectEntities = (
  fields: (ExtractedField & { section_id?: string })[]
): Map<string, { entity: string; id: string | null; value: Record<string, unknown>; source_block_ids: Set<string>; sections: Set<string> }> => {
  const out = new Map<string, { entity: string; id: string | null; value: Record<string, unknown>; source_block_ids: Set<string>; sections: Set<string> }>()
  const rank = new Map<string, { any: number; main: number | null }>()
  fields.forEach((f, i) => {
    const p = parseFieldPath(f.path)
    if (!p) return
    const key = `${p.entity}|${p.id ?? ""}`
    const r = rank.get(key) ?? { any: i, main: null }
    if (f.origin !== "vision" && r.main === null) r.main = i
    rank.set(key, r)
    const cur = out.get(key) ?? { entity: p.entity, id: p.id, value: {}, source_block_ids: new Set<string>(), sections: new Set<string>() }
    const next = f.edited_value !== undefined ? f.edited_value : f.value
    cur.value[p.field] = p.field in cur.value ? mergeFieldValue(p.field, cur.value[p.field], next) : next
    for (const b of f.source_block_ids) cur.source_block_ids.add(b)
    if (f.section_id) cur.sections.add(f.section_id)
    out.set(key, cur)
  })
  // FLF-411 (#7): phần tử chỉ đọc từ ảnh đứng SAU mọi phần tử chữ / bảng định nghĩa (giữa chúng giữ thứ tự ảnh nhắc tới) —
  // trước đây xếp theo chỗ ảnh nhắc đầu tiên ⇒ UC-03…UC-16 của sơ đồ 2.2.1 đứng trước UC-01, UC-02 của bảng 2.2.2
  const at = (key: string): number => rank.get(key)!.main ?? fields.length + rank.get(key)!.any
  return new Map([...out].sort(([a], [b]) => at(a) - at(b)))
}

/** Tên actor chung chung — sơ đồ hay vẽ làm actor cha (tổng quát hoá) của các actor thật. */
const GENERIC_ACTOR = /^(the\s+)?(users?|end[\s-]?users?|actors?|system users?|người dùng|người sử dụng|tác nhân)$/i

/**
 * FLF-361: actor chỉ đọc từ ảnh sơ đồ (`vision`), tên chung chung ("User" — actor cha vẽ trên sơ đồ ngữ cảnh / use case),
 * khi file đã liệt kê actor bằng chữ / bảng ⇒ không thêm vào Spine (FAP: `A08 | User | human` không có trong bảng 2.1).
 * Người dùng đã sửa field ở wizard ⇒ giữ. Trả khoá phần tử (`actors|A08`) cần bỏ; tham chiếu tới nó bị bỏ khi dựng op.
 */
export const imageOnlyGenericActors = (fields: readonly Pick<ExtractedField, "path" | "value" | "origin" | "edited_value">[]): Set<string> => {
  const byActor = new Map<string, Pick<ExtractedField, "path" | "value" | "origin" | "edited_value">[]>()
  for (const f of fields) {
    const p = parseFieldPath(f.path)
    if (p?.entity !== "actors") continue
    const key = `actors|${p.id ?? ""}`
    byActor.set(key, [...(byActor.get(key) ?? []), f])
  }
  const listed = [...byActor.values()].some((fs) => fs.some((f) => f.origin !== "vision"))
  if (!listed) return new Set()
  const out = new Set<string>()
  for (const [key, fs] of byActor) {
    if (fs.some((f) => f.origin !== "vision" || f.edited_value !== undefined)) continue
    const name = fs.find((f) => parseFieldPath(f.path)?.field === "name")?.value
    if (typeof name === "string" && GENERIC_ACTOR.test(name.trim())) out.add(key)
  }
  return out
}

/**
 * FLF-361: một phần tử, một cách viết mã — field của cùng phần tử trích từ nhiều nguồn ghi mã khác dạng (`UC01` ở bảng,
 * `UC-01` ở mục đặc tả) ⇒ dùng cách viết gặp đầu tiên cho mọi path (so theo `idKey`). Trước đây `normalizeKey` đổi mọi mã
 * sang `UC-01` nên không trùng, nhưng mất dạng mã của tài liệu.
 */
export const canonicalFieldIds = <F extends { path: string }>(fields: readonly F[]): F[] => {
  const first = new Map<string, string>()
  return fields.map((f) => {
    const p = parseFieldPath(f.path)
    if (!p?.id) return f
    const key = `${p.entity}|${idKey(p.id)}`
    const id = first.get(key) ?? p.id
    first.set(key, id)
    return id === p.id ? f : { ...f, path: f.path.replace(`${p.entity}[id=${p.id}]`, `${p.entity}[id=${id}]`) }
  })
}
