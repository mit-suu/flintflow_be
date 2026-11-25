/**
 * Vị trí của change request trên Spine (mode 1 v2 — FLF-186, plan v2 §8, D1): đơn vị là **phần tử Spine** (`project`,
 * `actors[id=A01]`, `custom_sections[id=CS02]`…) thay cho block của file docx. Hàm thuần — không DB.
 * - C-3 tìm: phần tử đích của C-2 + phần tử đang tham chiếu tới nó (`spine_link`), phần tử nhắc mã/tên của đích
 *   (`mention`), phần tử chứa từ khoá (`keyword`) — theo ranh giới từ, không phân biệt hoa thường.
 * - Hybrid retrieval: có ứng viên vector (`embedding/vector-search.ts`) thì chúng (`vector`) **thay** nguồn từ khoá;
 *   vị trí đồ thị (đích, tham chiếu, nhắc mã/tên) giữ nguyên như cũ và không bao giờ bị trần cắt vì ứng viên vector.
 * - Giá trị của vị trí được chụp thành chuỗi ổn định (`valueText`): C-5 so với Spine hiện tại để biết phần tử đã bị
 *   sửa ở chỗ khác kể từ lúc đề xuất (thay "old text khớp block" của bản theo block).
 */

import { createHash } from "node:crypto"
import { Bm25, reciprocalRankFusion } from "../../shared/search/bm25.js"
import { sectionHasData } from "../spine/deterministic-check.js"
import { ORIGINAL_DIAGRAM_DATA, OWNER_COLLECTION, OWNER_DIAGRAM_KINDS, originalDiagramOf, originalSectionOf } from "../spine/original-diagram.js"
import { impactOf } from "../spine/impact.service.js"
import { ownerStepOf, sectionsOfPath } from "../spine/section-registry.js"
import type { SectionSegments } from "../spine/segment-hash.js"
import type { Spine } from "../spine/spine.types.js"
import type { LocationFoundBy } from "./change-request.constants.js"
import { contentSlot } from "../import/content-slots.js"
import { COUNT_COLLECTIONS, findCountMentions, type CountCollection } from "./count-mentions.js"
import { literalHits, literalValues, type Literal } from "./literal-values.js"

export const PROJECT_PATH = "project"

/** Mảng phần tử có id làm được vị trí CR, theo thứ tự gần với thứ tự mục của tài liệu. */
export const LOCATION_ARRAYS = [
  "actors",
  "roles",
  "use_cases",
  "features",
  "screens",
  "permissions",
  "functions",
  "entities",
  "nfrs",
  "business_rules",
  "common_requirements",
  "messages",
  "other_requirements",
  "glossary",
  /** Mode 1 v3: cờ đỏ `unconfirmed_assumption` chỉ đóng được bằng CR (không còn S-9.2) ⇒ giả định phải làm được vị trí. */
  "assumptions",
  "custom_sections",
  // FLF-365: mục IEEE 29148 (Mode 1)
  "references",
  "verifications"
] as const

const ELEMENT = /^(\w+)\[id=([^\]]+)\]/

/**
 * C-2 có thể trả đích là **mã section** (`fixed:5.1`, `feature:F-01`, `custom:CS02`) — nhất là CR sinh từ gap report
 * ("xử lý các mục còn thiếu"). Trước đây loại target này bị bỏ im lặng ⇒ C-3 ra 0 vị trí mà không ai biết vì sao.
 */
const SECTION_TARGET = /^(fixed|feature|function|custom|group):/
export const isSectionTarget = (target: string): boolean => SECTION_TARGET.test(target)

/** `use_cases[id=UC-01].name` ⇒ `use_cases[id=UC-01]`; `project.vision` ⇒ `project`; còn lại ⇒ null. */
export const elementPathOf = (path: string): string | null => {
  if (path === PROJECT_PATH || path.startsWith(`${PROJECT_PATH}.`)) return PROJECT_PATH
  return ELEMENT.exec(path)?.[0] ?? null
}

/**
 * Vị trí **"mục đang trống"** (phương án B, chốt 2026-09-20): path là cả mảng (`business_rules[]`) thay vì một
 * phần tử. Mục chưa có phần tử nào thì không có gì để sửa — nhưng CR vẫn làm được việc thật: **thêm mới**.
 * Giá trị của vị trí là chính mảng đó, nên C-5 so được "mảng có bị ai khác thêm/bớt kể từ lúc đề xuất không".
 */
const ARRAY_PATH = /^(\w+)\[\]$/
export const isArrayPath = (path: string): boolean => ARRAY_PATH.test(path)

/**
 * Mảng nuôi nội dung của từng đầu mục FPT — soi ngược bảng `SECTION_HAS_DATA` của `deterministic-check.ts`.
 * Mode 1 v3: mục FPT trống chỉ điền được bằng CR (không còn step) ⇒ **mọi** mục mà luật `section_empty` soi phải có
 * đường vào: mảng ở đây, phần tử `project` (`fixed:1`), hoặc field trên phần tử có sẵn (`SECTION_FIELD_ARRAYS`).
 */
export const SECTION_FILL_ARRAYS: Readonly<Record<string, readonly string[]>> = {
  "fixed:2.1": ["actors"],
  "fixed:2.2.1": ["use_cases"],
  "fixed:2.2.2": ["use_cases"],
  "fixed:3.1.1": ["screens"],
  "fixed:3.1.2": ["screens"],
  "fixed:3.1.3": ["roles", "permissions"],
  "fixed:3.1.4": ["functions"],
  "fixed:3.1.5": ["entities"],
  "fixed:4.1": ["nfrs"],
  "fixed:4.2.1": ["nfrs"],
  "fixed:4.2.2": ["nfrs"],
  "fixed:4.2.3": ["nfrs"],
  "fixed:4.2.4": ["nfrs"],
  "fixed:5.1": ["business_rules"],
  "fixed:5.2": ["common_requirements"],
  "fixed:5.3": ["messages"],
  "fixed:5.4": ["other_requirements"],
  "fixed:5.5": ["glossary"]
}

/**
 * Mục có dữ liệu nằm ở **field của phần tử thuộc mục khác**: Screens Flow = `screens[].flow_to`, Use Case Diagram vẽ từ
 * `use_cases`. Nhắm mục này ⇒ mọi phần tử của mảng là vị trí (sửa field), mảng rỗng thì thêm mới.
 */
export const SECTION_FIELD_ARRAYS: Readonly<Record<string, string>> = {
  "fixed:2.2.1": "use_cases",
  "fixed:3.1.1": "screens"
}

/**
 * Đích là **phần nhỏ của mẫu** (`slot:business_rules`, FLF-278 — mẫu cố định đặt tên mục khác mẫu FPT): không phải mục Spine
 * ⇒ đổi sang mục FPT cha (`fixed:5.1`) hoặc, phần nhỏ không có cha, sang mảng dữ liệu của nó (`functions[]`, `project`).
 * Trước đây đích `slot:*` bị bỏ im lặng ⇒ CR nhắm mục mẫu trống ra 0 vị trí.
 */
export const expandSlotTargets = (targets: readonly string[]): string[] => [
  ...new Set(
    targets.flatMap((t) => {
      const slot = t.startsWith("slot:") ? contentSlot(t) : undefined
      if (!slot) return [t]
      if (slot.parents.length) return [...slot.parents]
      return slot.targets.map((target) => (target === PROJECT_PATH ? PROJECT_PATH : `${target}[]`))
    })
  )
]

/** Path thêm mới cho một section đang trống (`fixed:5.1` ⇒ `business_rules[]`); section không đổ được ⇒ []. */
export const fillPathsOfSection = (sectionId: string): string[] => (SECTION_FILL_ARRAYS[sectionId] ?? []).map((arr) => `${arr}[]`)

type Row = Record<string, unknown>

const arrayOf = (spine: Spine, key: string): Row[] => {
  const value = (spine as unknown as Record<string, unknown>)[key]
  return Array.isArray(value) ? (value as Row[]) : []
}

/** Giá trị hiện tại của phần tử — `undefined` nếu không còn. Path dạng `arr[]` (vị trí "mục trống") ⇒ cả mảng. */
export const elementValue = (spine: Spine, path: string): unknown => {
  if (path === PROJECT_PATH) return spine.project
  const array = ARRAY_PATH.exec(path)
  if (array) return arrayOf(spine, array[1])
  const m = ELEMENT.exec(path)
  if (!m || m[0] !== path) return undefined
  return arrayOf(spine, m[1]).find((el) => String(el.id) === m[2])
}

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Row)
        .sort()
        .map((k) => [k, sortKeys((value as Row)[k])])
    )
  }
  return value
}

/** Chuỗi ổn định (khoá sắp xếp) của giá trị — hiển thị cho người duyệt và so ở C-5. Phần tử không còn ⇒ "". */
export const valueText = (value: unknown): string => (value === undefined ? "" : JSON.stringify(sortKeys(value), null, 2))

/** sha256 hex — `base_hash` của vị trí "thêm mới". */
export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex")

/**
 * Chụp giá trị lúc đề xuất (FLF-308). Vị trí phần tử: `old_text` = giá trị phần tử. Vị trí "thêm mới" (`arr[]`): chép cả
 * mảng làm request CR nặng hàng trăm KB (`functions[]` 111 KB) mà người duyệt chỉ cần phần tử thêm ⇒ `old_text = "[]"`,
 * còn mảng lúc đề xuất giữ bằng `base_hash` để C-5/C-7 vẫn biết có ai sửa mảng ở chỗ khác không.
 */
export const snapshotOf = (spine: Spine, path: string): { old_text: string; base_hash: string | null } =>
  isArrayPath(path) ? { old_text: "[]", base_hash: sha256(valueText(elementValue(spine, path))) } : { old_text: valueText(elementValue(spine, path)), base_hash: null }

/** Giá trị tại `path` chưa đổi kể từ lúc chụp (`snapshotOf`); bản ghi cũ (không có `base_hash`) so `old_text`. */
export const unchangedSince = (spine: Spine, path: string, proposal: { old_text: string; base_hash?: string | null }): boolean => {
  const current = valueText(elementValue(spine, path))
  return proposal.base_hash ? sha256(current) === proposal.base_hash : current === proposal.old_text
}

/** Giá trị hiện tại gửi FE (`current_text`): vị trí "thêm mới" ⇒ `"[]"` — phần tử có sẵn là các vị trí riêng. */
export const currentText = (spine: Spine, path: string): string => (isArrayPath(path) ? "[]" : valueText(elementValue(spine, path)))

/** Phần tử của `after` không có trong `before` (khớp theo `id`, phần tử không id thì theo giá trị) — vị trí `arr[]` sau op. */
export const addedElements = (before: unknown, after: unknown): unknown[] => {
  const prev = Array.isArray(before) ? before : []
  const ids = new Set(prev.flatMap((el) => (el && typeof el === "object" && "id" in el ? [String((el as Row).id)] : [])))
  const texts = new Set(prev.map(valueText))
  return (Array.isArray(after) ? after : []).filter((el) =>
    el && typeof el === "object" && "id" in el ? !ids.has(String((el as Row).id)) : !texts.has(valueText(el))
  )
}

/** Mọi chuỗi trong giá trị, nối lại — để tìm từ khoá / mã / tên. */
const textOf = (value: unknown): string => {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(textOf).join("\n")
  if (value && typeof value === "object") return Object.values(value as Row).map(textOf).join("\n")
  return ""
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const wordPattern = (s: string): RegExp => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(s)}(?![\\p{L}\\p{N}])`, "iu")

/** Tỉ lệ điểm BM25 tối thiểu so với phần tử khớp nhất, và số phần tử tối đa lấy theo từ khoá (FLF-375). */
export const KEYWORD_MIN_RATIO = 0.35
export const KEYWORD_MAX_HITS = 15

/**
 * FLF-375: phần tử Spine xếp theo BM25 của từ khoá C-2 (`shared/search/bm25.ts` — tách âm tiết Việt, bỏ dấu, giữ mã).
 * Mỗi từ khoá là một ý riêng ⇒ chấm **theo từng từ khoá**: giữ phần tử có điểm ≥ `KEYWORD_MIN_RATIO` × điểm cao nhất của
 * chính từ khoá đó (phần tử chỉ khớp một ý không bị ý khác lấn át), hợp lại theo điểm chuẩn hoá, tối đa `KEYWORD_MAX_HITS`.
 */
export const rankByKeywords = (elements: readonly { path: string; value: unknown }[], keywords: readonly string[]): { path: string; score: number }[] => {
  const terms = [...new Set(keywords.map((k) => k.trim()).filter((k) => k.length >= 2))]
  if (!terms.length) return []
  const index = new Bm25(elements, (e) => textOf(e.value))
  const best = new Map<string, number>()
  for (const term of terms) {
    const hits = index.search(term)
    const top = hits[0]?.score ?? 0
    for (const h of hits) {
      if (h.score < top * KEYWORD_MIN_RATIO) continue
      const norm = top ? h.score / top : 0
      best.set(h.item.path, Math.max(best.get(h.item.path) ?? 0, norm))
    }
  }
  return [...best.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, KEYWORD_MAX_HITS)
    .map(([path, score]) => ({ path, score }))
}

/** Section chứa phần tử (ưu tiên section sở hữu). Không ra section ⇒ `misc`. */
export const sectionOfElement = (spine: Spine, path: string): string => {
  if (path === PROJECT_PATH) return "fixed:1"
  const impact = sectionsOfPath(spine, path)
  return impact.owner[0] ?? impact.reads[0] ?? "misc"
}

/** Field của `project` có mục riêng (phần nhỏ của mẫu bắt buộc) — field khác thuộc `fixed:1`. */
const PROJECT_FIELD_SLOT: Readonly<Record<string, string>> = {
  goals: "slot:goals",
  vision: "slot:vision",
  release_scope: "slot:scope",
  form_factor: "slot:platforms"
}

/** Field `project` mà op chạm: `project.goals` / `project.release_scope.in` ⇒ `goals` / `release_scope`. Theo thứ tự op, không trùng. */
export const projectFieldsOfOps = (ops: readonly unknown[]): string[] => {
  const fields: string[] = []
  for (const o of ops) {
    const path = o && typeof o === "object" ? (o as Row).path : undefined
    const m = typeof path === "string" ? /^project\.(\w+)/.exec(path) : null
    if (m && !fields.includes(m[1])) fields.push(m[1])
  }
  return fields
}

/**
 * Lỗi #6: mục của vị trí `project` theo field bị đổi — `goals` ⇒ `slot:goals`… nếu layout của dự án có phần nhỏ đó, còn lại
 * `fixed:1`. Không biết field nào đổi ⇒ `null` (giữ section đã lưu).
 */
export const projectSectionOf = (fields: readonly string[], layout?: readonly { section_id: string }[]): string | null => {
  if (!fields.length) return null
  const present = new Set((layout ?? []).map((l) => l.section_id))
  const slot = fields.map((f) => PROJECT_FIELD_SLOT[f]).find((s) => s && present.has(s))
  return slot ?? "fixed:1"
}

export interface SpineElement {
  path: string
  value: unknown
}

/** Mọi phần tử làm được vị trí, theo thứ tự `LOCATION_ARRAYS`. */
export const listElements = (spine: Spine): SpineElement[] => [
  { path: PROJECT_PATH, value: spine.project },
  ...LOCATION_ARRAYS.flatMap((arr) => arrayOf(spine, arr).map((el) => ({ path: `${arr}[id=${String(el.id)}]`, value: el as unknown })))
]

export interface FoundLocation {
  path: string
  section_id: string
  found_by: LocationFoundBy[]
  /** Phần tử đích của CR mà vị trí này liên quan. */
  entity_paths: string[]
  owner_step: string | null
  /** Chỉ có khi `found_by` chứa `vector`: điểm gần nghĩa (0..1). */
  vector_score?: number
  /** FLF-375: chỉ có khi `found_by` chứa `keyword` — điểm BM25 của phần tử theo từ khoá. */
  keyword_score?: number
  /** FLF-375: điểm trộn RRF (BM25 + vector) của vị trí tìm theo từ khoá / nghĩa — thứ tự giữ lại khi phải cắt. */
  recall_score?: number
}

/** Ứng viên từ Atlas Vector Search: path phần tử + điểm. Path không còn trong Spine bị bỏ. */
export interface VectorCandidate {
  ref: string
  score: number
}

/**
 * C-3: gom vị trí từ đích C-2 (`targets` — path phần tử hoặc field) và từ khoá. Đích không còn trong Spine bị bỏ.
 * `vector` khác rỗng ⇒ ứng viên gần nghĩa thay nguồn từ khoá (từ khoá chỉ còn là dự phòng khi index không dùng được).
 */
export interface FindOptions {
  /** FLF-483: giá trị cụ thể của CR (`literalValues`) - phần tử ghi giá trị đó luôn là vị trí, không qua xếp hạng / trần từ khoá. */
  literals?: readonly Literal[]
}

export const findSpineLocations = (
  spine: Spine,
  targets: readonly string[],
  keywords: readonly string[],
  vector: readonly VectorCandidate[] = [],
  options: FindOptions = {}
): FoundLocation[] => {
  targets = expandSlotTargets(targets)
  const elements = listElements(spine)
  const exists = new Set(elements.map((e) => e.path))
  const hits = new Map<string, { found_by: Set<LocationFoundBy>; entity_paths: Set<string> }>()
  const hit = (path: string, by: LocationFoundBy, about?: string) => {
    if (!exists.has(path)) return
    const cur = hits.get(path) ?? { found_by: new Set<LocationFoundBy>(), entity_paths: new Set<string>() }
    cur.found_by.add(by)
    if (about) cur.entity_paths.add(about)
    hits.set(path, cur)
  }

  const targetElements = [...new Set(targets.map(elementPathOf).filter((p): p is string => !!p && exists.has(p)))]
  for (const t of targetElements) hit(t, "spine_link", t)

  // Đích là mã section ⇒ mọi phần tử section đó sở hữu là vị trí (liên kết cấu trúc, không phải nhắc tên)
  const sectionTargets = [...new Set(targets.filter(isSectionTarget))]
  if (sectionTargets.length) {
    for (const e of elements) {
      const section = sectionOfElement(spine, e.path)
      if (sectionTargets.includes(section)) hit(e.path, "spine_link", section)
    }
  }
  const idTargets = targetElements.filter((t) => t !== PROJECT_PATH)
  for (const r of impactOf(spine, idTargets).referrers) {
    const el = elementPathOf(r.path)
    const about = idTargets.find((t) => t.endsWith(`[id=${r.id}]`))
    if (el) hit(el, "spine_link", about)
  }

  // Mã + tên của đích nhắc trong phần tử khác (văn xuôi, mô tả, mục riêng).
  // Phần tử đã tham chiếu đích bằng field (`spine_link`) thì hầu như luôn chứa mã đích trong text ⇒ không gắn thêm
  // `mention` cho cùng đích đó (nợ T10): `found_by` chỉ kể cách tìm ra thật sự khác nhau.
  const linkedTo = (path: string, target: string): boolean => {
    const h = hits.get(path)
    return !!h && h.found_by.has("spine_link") && h.entity_paths.has(target)
  }
  for (const t of idTargets) {
    const value = elementValue(spine, t) as Row | undefined
    const names = [ELEMENT.exec(t)?.[2], typeof value?.name === "string" ? value.name : undefined, typeof value?.term === "string" ? value.term : undefined]
      .filter((s): s is string => !!s && s.trim().length >= 2)
      .map(wordPattern)
    for (const e of elements) {
      if (e.path === t || linkedTo(e.path, t)) continue
      if (names.some((re) => re.test(textOf(e.value)))) hit(e.path, "mention", t)
    }
  }

  // FLF-375: từ khoá xếp hạng bằng BM25 (thay regex có / không) — chỉ giữ phần tử điểm đủ cao so với phần tử khớp nhất,
  // bớt chỗ "không liên quan" AI phải đọc; có vector thì KHÔNG bỏ từ khoá nữa mà trộn hai nguồn bằng RRF
  // FLF-483: từ khoá là giá trị cụ thể ("5 triệu") đã đi đường riêng bên dưới - khỏi đếm hai lần và khỏi chiếm chỗ trong trần
  const literals = options.literals ?? []
  const plainKeywords = literals.length ? keywords.filter((k) => literalValues(k).length === 0) : keywords
  const keywordRanked = rankByKeywords(elements, plainKeywords)
  const keywordScores = new Map(keywordRanked.map((r) => [r.path, r.score]))
  for (const r of keywordRanked) hit(r.path, "keyword")
  // FLF-483 (ChoViet #4): mọi phần tử ghi giá trị cụ thể của CR, không tính vào `KEYWORD_MAX_HITS`, điểm cao nhất
  const literalPaths = literalHits(elements, literals)
  for (const path of literalPaths) {
    hit(path, "keyword")
    keywordScores.set(path, 1)
  }
  const scores = new Map<string, number>()
  for (const v of vector) {
    if (!exists.has(v.ref)) continue
    hit(v.ref, "vector")
    scores.set(v.ref, Math.max(scores.get(v.ref) ?? 0, v.score))
  }
  const fused = reciprocalRankFusion([
    keywordRanked.map((r) => r.path),
    [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([path]) => path)
  ])

  for (const path of literalPaths) fused.set(path, 1) // RRF chỉ cỡ 0.03 ⇒ 1 luôn đứng đầu khi phải cắt bớt
  const found: FoundLocation[] = elements
    .filter((e) => hits.has(e.path))
    .map((e) => {
      const h = hits.get(e.path)!
      const section_id = sectionOfElement(spine, e.path)
      return {
        path: e.path,
        section_id,
        found_by: [...h.found_by],
        entity_paths: [...h.entity_paths],
        owner_step: section_id === "misc" || section_id.startsWith("custom:") ? null : ownerStepOf(section_id, spine),
        ...(scores.has(e.path) ? { vector_score: scores.get(e.path)! } : {}),
        ...(keywordScores.has(e.path) ? { keyword_score: keywordScores.get(e.path)! } : {}),
        ...(fused.has(e.path) ? { recall_score: fused.get(e.path)! } : {})
      }
    })

  // Mục có dữ liệu ở field của phần tử mục khác ⇒ phần tử đó là vị trí, gắn với mục được nhắm (step sở hữu = step
  // của mục đó, vd S-4.2 cho Screens Flow)
  const seen = new Set(found.map((f) => f.path))
  for (const section of new Set(targets.filter((t) => t in SECTION_FIELD_ARRAYS))) {
    const arr = SECTION_FIELD_ARRAYS[section]!
    for (const el of arrayOf(spine, arr)) {
      const path = `${arr}[id=${String(el.id)}]`
      if (seen.has(path)) continue
      seen.add(path)
      found.push({ path, section_id: section, found_by: ["spine_link"], entity_paths: [section], owner_step: ownerStepOf(section, spine) })
    }
  }

  // Ô **thêm mới** (`arr[]`) — phương án B cho mục trống, mở rộng 2026-09-24 cho mọi mục được nhắm: CR "thêm bảng /
  // thực thể / quyền mới" vào mục đã có dữ liệu trước đây chỉ ra các phần tử cũ ⇒ AI không có chỗ thêm, đành comment.
  // Section không đổ được bằng mảng thì bỏ qua ở đây, `emptySectionTargets` báo tiếp.
  const slots: FoundLocation[] = []
  const addSlot = (path: string, section: string) => {
    if (seen.has(path)) return
    seen.add(path)
    slots.push({ path, section_id: section, found_by: ["spine_link"], entity_paths: [section], owner_step: ownerStepOf(section, spine) })
  }
  const empty = new Set(emptySections(spine, targets))
  for (const section of new Set(targets.filter(isSectionTarget))) {
    const fieldArray = SECTION_FIELD_ARRAYS[section]
    // Mục "field" trống vì field của phần tử có sẵn còn trống ⇒ sửa phần tử đó, không mời thêm phần tử mới
    if (empty.has(section) && fieldArray && arrayOf(spine, fieldArray).length) continue
    for (const path of fillPathsOfSection(section)) addSlot(path, section)
    // FLF-469 (B.2): mục tính năng / chức năng (3.x.y) cũng có ô thêm chức năng / màn, gắn đúng mục tính năng chứa nó
    for (const slot of featureSlots(spine, section)) addSlot(slot.path, slot.section)
  }
  // C-2 trả thẳng đích thêm mới (`entities[]`) khi thay đổi cần phần tử chưa có
  for (const t of targets) {
    const array = ARRAY_PATH.exec(t)?.[1]
    const section = array ? sectionOfArray(array, targets) : null
    if (section) addSlot(`${array}[]`, section)
  }
  // §4.13: sơ đồ gốc của người dùng mà CR chạm tới dữ liệu ⇒ vị trí "vẽ lại hình" (đề xuất do code tính ở C-4)
  const diagrams = originalDiagramLocations(spine, targets, [...found, ...slots])
  for (const d of diagrams) {
    const same = found.find((f) => f.path === d.path)
    if (same) {
      same.found_by = [...new Set([...same.found_by, ...d.found_by])]
      same.entity_paths = [...new Set([...same.entity_paths, ...d.entity_paths])]
    }
  }
  const extra = diagrams.filter((d) => !found.some((f) => f.path === d.path))
  // C-3 liệt kê đủ mọi vị trí chạm tới, không cắt trần (BF §3.2); chi phí C-4 báo trước ở `proposeEstimate`
  return [...found, ...slots, ...extra]
}

/**
 * FLF-469 (B.2): ô "thêm mới" của mục tính năng (`feature:<id>`) hoặc chức năng (`function:<id>`): `functions[]` (và
 * `screens[]` với mục tính năng) gắn đúng mục tính năng chứa chúng - không đẩy về mục 3.1.4 (chức năng không màn hình).
 */
export const featureSlots = (spine: Spine, section: string): { path: string; section: string }[] => {
  if (section.startsWith("feature:")) {
    const id = section.slice("feature:".length)
    return arrayOf(spine, "features").some((f) => String(f.id) === id) ? [{ path: "functions[]", section }, { path: "screens[]", section }] : []
  }
  if (section.startsWith("function:")) {
    const fn = arrayOf(spine, "functions").find((f) => `function:${String(f.id)}` === section)
    return fn && typeof fn.feature_id === "string" ? [{ path: "functions[]", section: `feature:${fn.feature_id}` }] : []
  }
  return []
}

/** Mảng Spine mà path thuộc về: `use_cases[id=UC-01]` / `use_cases[]` ⇒ `use_cases`; `project` ⇒ `project`. */
const arrayKeyOf = (path: string): string | null =>
  path === PROJECT_PATH || path.startsWith(`${PROJECT_PATH}.`) ? PROJECT_PATH : (ARRAY_PATH.exec(path)?.[1] ?? ELEMENT.exec(path)?.[1] ?? null)

/**
 * Phần nối đang giữ sơ đồ gốc (§4.13) mà CR có thể làm lệch: vị trí khác của CR chạm dữ liệu hình thể hiện
 * (`ORIGINAL_DIAGRAM_DATA`), hoặc CR nhắm thẳng mục của hình / chính phần nối (vd tạo từ cờ `original_diagram_stale`).
 * Chỉ là ứng viên — C-4 so hash dữ liệu sau CR để kết luận vẽ lại hay không.
 */
export const originalDiagramLocations = (spine: Spine, targets: readonly string[], found: readonly Pick<FoundLocation, "path">[]): FoundLocation[] => {
  const touched = new Set(found.map((f) => arrayKeyOf(f.path)).filter((k): k is string => !!k))
  const out: FoundLocation[] = []
  for (const c of spine.custom_sections) {
    const diagrams = c.blocks.map(originalDiagramOf).flatMap((d) => (d ? [d] : []))
    if (!diagrams.length) continue
    const path = `custom_sections[id=${c.id}]`
    // FLF-390: sơ đồ gắn phần tử ⇒ dữ liệu của hình là chính chủ đó (function / use case) và actor, không phải cả mảng
    const touches = (d: (typeof diagrams)[number]) =>
      OWNER_DIAGRAM_KINDS.has(d.kind)
        ? found.some((f) => f.path.startsWith(`${OWNER_COLLECTION[d.kind]}[id=${d.owner_id}]`)) || touched.has("actors")
        : ORIGINAL_DIAGRAM_DATA[d.kind].some((a) => touched.has(a))
    const hit = diagrams.filter(
      (d) => touches(d) || targets.includes(originalSectionOf(d)) || targets.includes(`custom:${c.id}`) || targets.some((t) => elementPathOf(t) === path)
    )
    if (!hit.length) continue
    out.push({ path, section_id: sectionOfElement(spine, path), found_by: ["diagram"], entity_paths: [...new Set(hit.map(originalSectionOf))], owner_step: null })
  }
  return out
}

/**
 * FLF-375: vị trí của lô thêm / xoá use case đã duyệt trong chat (FLF-318) cũng phải kèm sơ đồ gốc mà lô làm lệch —
 * trước đây nhánh này bỏ qua ⇒ thêm use case xong, sơ đồ use case / luồng màn của file vẫn là hình cũ.
 */
export const withOriginalDiagrams = (spine: Spine, targets: readonly string[], found: FoundLocation[]): FoundLocation[] =>
  mergeFoundLocations(found, originalDiagramLocations(spine, targets, found))

/**
 * Gộp vị trí mới vào danh sách đã có: cùng `path` thì hợp `found_by` / `entity_paths` (một phần tử có thể được tìm thấy
 * bằng nhiều cách — vd sơ đồ gốc + câu đếm), khác `path` thì thêm mới. Dùng cho sơ đồ gốc (§4.13) và câu đếm (FLF-473).
 */
export const mergeFoundLocations = (found: readonly FoundLocation[], extra: readonly FoundLocation[]): FoundLocation[] => {
  const out = found.map((f) => ({ ...f }))
  for (const e of extra) {
    const same = out.find((f) => f.path === e.path)
    if (same) {
      same.found_by = [...new Set([...same.found_by, ...e.found_by])]
      same.entity_paths = [...new Set([...same.entity_paths, ...e.entity_paths])]
    } else out.push({ ...e })
  }
  return out
}

/**
 * FLF-473 (EduCampus B14): câu đếm trong văn xuôi ("Hệ thống có 10 use case") mà CR thực sự làm đổi số phần tử của
 * đúng loại đó. `after`: Spine sau khi áp thử ops của CR (lô use case đã duyệt, hoặc ops xem trước đính kèm CR) — chưa
 * tính được (op lỗi, hoặc CR không mang ops nào) ⇒ `null`, bỏ qua (không bắt nhầm câu đếm khi chưa chắc số đổi thế nào).
 * Chỉ thêm vị trí cho loại phần tử CR thực sự đổi số — câu đếm actor không phải vị trí của CR chỉ thêm use case.
 * Lưu ý: với `found_by: "count"`, `entity_paths` giữ tên **collection** (`"use_cases"`…), không phải path phần tử như
 * các nguồn khác — C-4/C-5 (`propose.service.ts`, `verify.service.ts`) đọc đúng field này để biết đếm loại nào.
 */
export const countMentionLocations = (spine: Spine, after: Spine | null): FoundLocation[] => {
  if (!after) return []
  const changed = new Set<CountCollection>(COUNT_COLLECTIONS.filter((c) => arrayOf(spine, c).length !== arrayOf(after, c).length))
  if (!changed.size) return []
  const byPath = new Map<string, FoundLocation>()
  for (const m of findCountMentions(spine)) {
    if (!changed.has(m.collection)) continue
    const section_id = sectionOfElement(spine, m.path)
    const cur = byPath.get(m.path)
    if (cur) {
      cur.entity_paths = [...new Set([...cur.entity_paths, m.collection])]
      continue
    }
    byPath.set(m.path, {
      path: m.path,
      section_id,
      found_by: ["count"],
      entity_paths: [m.collection],
      owner_step: section_id === "misc" || section_id.startsWith("custom:") ? null : ownerStepOf(section_id, spine)
    })
  }
  return [...byPath.values()]
}

/** Mục nuôi bằng mảng `array` — ưu tiên mục CR đang nhắm; mảng không nuôi mục nào ⇒ null. */
const sectionOfArray = (array: string, targets: readonly string[]): string | null => {
  const sections = Object.entries(SECTION_FILL_ARRAYS)
    .filter(([, arrays]) => arrays.includes(array))
    .map(([section]) => section)
  return sections.find((s) => targets.includes(s)) ?? sections[0] ?? null
}

/**
 * Đích dạng mã section còn trống: chưa có phần tử nào thuộc về, **hoặc** luật cờ `section_empty` coi là chưa có dữ liệu
 * (`SECTION_HAS_DATA` — vd 5.1 chỉ có rule `tier=high`). Dùng chung tiêu chí với cờ để CR luôn có lối đóng cờ (L10).
 */
const emptySections = (spine: Spine, targets: readonly string[]): string[] => {
  const sections = [...new Set(targets.filter(isSectionTarget))]
  if (!sections.length) return []
  const filled = new Set(listElements(spine).map((e) => sectionOfElement(spine, e.path)))
  return sections.filter((s) => !filled.has(s) || sectionHasData(spine, s) === false)
}

/**
 * Đích section trống mà **cũng không thêm mới được** (không có mảng nào nuôi mục đó — vd `fixed:1` là phần tử
 * `project`, `fixed:3.1.1` là field của màn có sẵn). Đây mới là ca phải chạy step soạn nội dung thay vì mở CR.
 */
export const emptySectionTargets = (spine: Spine, targets: readonly string[]): string[] =>
  emptySections(spine, expandSlotTargets(targets)).filter((s) => fillPathsOfSection(s).length === 0)

/** Phần tử mà op chạm tới (để đòi khoá): `actors[id=A01].name` ⇒ `actors[id=A01]`; `actors[]` (thêm mới) ⇒ null. */
export const opElement = (opPath: string): string | null => elementPathOf(opPath)

/**
 * P08 (upload U2-7): CR "đổi tên hệ thống thành X" / "rename the system to X" — nhận dạng tất định trên câu của người yêu
 * cầu. Trả tên mới; không phải lệnh đổi tên hệ thống ⇒ `null`. Chỉ một câu lệnh đổi tên đứng riêng (không kèm yêu cầu khác
 * sau dấu chấm / "và") mới tính, để CR nhiều việc vẫn tìm vị trí như thường.
 */
const SYSTEM_RENAME = [
  /(?:đổi|thay|sửa)\s+tên\s+(?:của\s+)?(?:hệ\s+thống|ứng\s+dụng|app|sản\s+phẩm|phần\s+mềm)(?:\s+[^\s,.;:]+)?\s+(?:thành|sang|là)\s+["“'‘]?([^"”'’\n]+?)["”'’]?\s*[.!]?\s*$/iu,
  /rename\s+(?:the\s+)?(?:system|app|application|product)(?:\s+[^\s,.;:]+)?\s+(?:to|as)\s+["“'‘]?([^"”'’\n]+?)["”'’]?\s*[.!]?\s*$/iu
]

export const systemRenameTarget = (text: string): string | null => {
  for (const line of text.split(/\n/).map((l) => l.trim()).filter(Boolean)) {
    for (const re of SYSTEM_RENAME) {
      const name = re.exec(line)?.[1]?.trim()
      if (name && name.length >= 2 && !/\s(?:và|and)\s/iu.test(name)) return name
    }
  }
  return null
}

/**
 * Vị trí của CR đổi tên hệ thống: phần tử `project` (field `system_name`) + phần tử có nhắc nguyên tên hệ thống hiện tại.
 * Không dò theo từ khoá / nghĩa — tên hệ thống không dính "Product Catalog", "MSG-17"… (trước đây 19 phần liên quan).
 */
export const systemRenameLocations = (spine: Spine, currentName: string): FoundLocation[] => {
  const name = currentName.trim()
  const re = name.length >= 2 ? wordPattern(name) : null
  return listElements(spine)
    .filter((e) => e.path === PROJECT_PATH || (re !== null && re.test(textOf(e.value))))
    .map((e) => {
      const section_id = sectionOfElement(spine, e.path)
      return {
        path: e.path,
        section_id,
        found_by: [e.path === PROJECT_PATH ? ("spine_link" as const) : ("mention" as const)],
        entity_paths: [PROJECT_PATH],
        owner_step: section_id === "misc" || section_id.startsWith("custom:") ? null : ownerStepOf(section_id, spine)
      }
    })
}

/**
 * C-3 "sửa chữ" (BF §3.2): đoạn văn giữ nguyên của file gốc (`TemplateProfile.section_segments`, đoạn `original` = mục riêng
 * `custom_sections[id=…]`) nhắc tên / mã của phần tử mà CR đụng tới ⇒ vị trí để CR sửa chữ trong đoạn đó (đổi tên actor mà
 * đoạn văn còn tên cũ thì không còn cờ đỏ sau khi ghi). Dùng danh sách nhắc lúc import (`mentions`) nên bắt cả cách viết
 * khác của mã (`UC01` / `UC-01`). Đã là vị trí rồi thì chỉ gắn thêm phần tử gây ra.
 */
export const originalPassageLocations = (spine: Spine, records: readonly SectionSegments[], found: readonly Pick<FoundLocation, "path">[]): FoundLocation[] => {
  const changed = new Set(found.map((f) => f.path))
  const exists = new Set(spine.custom_sections.map((c) => c.id))
  const out = new Map<string, FoundLocation>()
  for (const r of records) {
    for (const part of r.parts) {
      if (part.kind !== "original" || !exists.has(part.custom_id)) continue
      const hit = part.mentions.map((m) => m.path).filter((p) => changed.has(p))
      if (!hit.length) continue
      const path = `custom_sections[id=${part.custom_id}]`
      const cur = out.get(path) ?? { path, section_id: sectionOfElement(spine, path), found_by: ["mention" as const], entity_paths: [], owner_step: null }
      cur.entity_paths = [...new Set([...cur.entity_paths, ...hit])]
      out.set(path, cur)
    }
  }
  return [...out.values()]
}

/** Gộp vị trí đoạn nguyên văn vào kết quả C-3: đã có thì nối `found_by` / `entity_paths`, chưa có thì thêm cuối. */
export const withOriginalPassages = (spine: Spine, records: readonly SectionSegments[], found: FoundLocation[]): FoundLocation[] => {
  const out = found.map((f) => ({ ...f }))
  for (const p of originalPassageLocations(spine, records, found)) {
    const same = out.find((f) => f.path === p.path)
    if (same) {
      same.found_by = [...new Set([...same.found_by, ...p.found_by])]
      same.entity_paths = [...new Set([...same.entity_paths, ...p.entity_paths])]
    } else out.push(p)
  }
  return out
}

/**
 * FLF-480 (P09 #5): CR "bỏ quy tắc BR-03" / "remove UC-09" — nhận dạng tất định câu xoá một phần tử theo mã tài liệu.
 * Trả mã; không phải lệnh xoá đứng riêng (kèm yêu cầu khác sau "và" / "and") ⇒ `null`, CR đó tìm vị trí như thường.
 */
const REMOVE_ELEMENT =
  /^(?:(?:xo[áà]|bỏ|loại\s+bỏ|gỡ(?:\s+bỏ)?|remove|delete|drop)\s+(?:hẳn\s+)?(?:(?:quy\s+tắc|luật|use\s*case|usecase|chức\s+năng|màn(?:\s+hình)?|yêu\s+cầu|rule|business\s+rule|requirement|function|screen|actor|tác\s+nhân)\s+)?)["“'‘]?([A-Za-z]{1,6}-\d+(?:\.\d+)*)["”'’]?\s*[.!]?\s*$/iu

export const removeElementTarget = (text: string): string | null => {
  for (const line of text.split(/\n/).map((l) => l.trim()).filter(Boolean)) {
    const code = REMOVE_ELEMENT.exec(line)?.[1]
    if (code) return code
  }
  return null
}

/**
 * Vị trí của CR xoá phần tử theo mã: chính phần tử + phần tử tham chiếu id đó (`business_rule_ids`, `includes`…) + phần tử có
 * văn xuôi nhắc mã / tên. Không dò BM25 rộng (trước đây 22 phần được dò, chỉ 4 có đề xuất). Không có phần tử mang mã ⇒ [].
 */
export const removeElementLocations = (spine: Spine, code: string): FoundLocation[] => {
  const elements = listElements(spine)
  const target = elements.find((e) => ELEMENT.exec(e.path)?.[2]?.toLowerCase() === code.toLowerCase())
  if (!target) return []
  const value = target.value as Row | undefined
  const names = [code, typeof value?.name === "string" ? value.name : undefined]
    .filter((x): x is string => !!x && x.trim().length >= 2)
    .map(wordPattern)
  const referrers = new Set(impactOf(spine, [target.path]).referrers.map((r) => elementPathOf(r.path)).filter((x): x is string => !!x))
  return elements
    .filter((e) => e.path === target.path || referrers.has(e.path) || names.some((re) => re.test(textOf(e.value))))
    .map((e) => {
      const section_id = sectionOfElement(spine, e.path)
      return {
        path: e.path,
        section_id,
        found_by: [e.path === target.path || referrers.has(e.path) ? ("spine_link" as const) : ("mention" as const)],
        entity_paths: [target.path],
        owner_step: section_id === "misc" || section_id.startsWith("custom:") ? null : ownerStepOf(section_id, spine)
      }
    })
}

/** FLF-469 (D): tối đa vị trí "nhắc tới" thêm cho phần tử bị lô xoá (không đè trần `MAX_LOCATIONS`). */
export const MAX_REMOVED_MENTIONS = 20

/**
 * FLF-469 (D): cách người ta gọi tắt một tên phần tử trong văn xuôi - mã, tên đầy đủ, và tên ngắn (động từ / từ đầu +
 * từ cuối của tên từ 3 từ trở lên: "Xuất thời khóa biểu ra Excel" ⇒ "Xuất Excel"). Luật rẻ, hụt nhiều hơn nhờ AI.
 */
export const mentionNames = (id: string | undefined, name: string | undefined): string[] => {
  const full = name?.trim() ?? ""
  const words = full.split(/\s+/).filter(Boolean)
  const short = words.length >= 3 ? `${words[0]} ${words[words.length - 1]}` : ""
  return [...new Set([id ?? "", full, short].map((s) => s.trim()).filter((s) => s.length >= 2))]
}

/**
 * FLF-469 (D): phần tử bị lô xoá (có trong `spine`, không còn trong `after`) mà văn xuôi / phần tử khác vẫn nhắc tới theo mã,
 * tên đầy đủ hoặc tên ngắn - kể cả đoạn nguyên văn (`custom_sections`). Bỏ qua: chính các phần tử bị xoá, phần tử đã là vị
 * trí (`exclude`) và phần tử tham chiếu tới nó bằng field (op xoá tự gỡ tham chiếu). Mỗi chỗ khớp là vị trí `mention`.
 */
export const removedMentionLocations = (spine: Spine, after: Spine, exclude: ReadonlySet<string>, limit = MAX_REMOVED_MENTIONS): FoundLocation[] => {
  const elements = listElements(spine)
  const removed = elements.filter((e) => e.path !== PROJECT_PATH && elementValue(after, e.path) === undefined)
  if (!removed.length) return []
  const gone = new Set(removed.map((r) => r.path))
  const referrers = new Set(impactOf(spine, [...gone]).referrers.flatMap((r) => (elementPathOf(r.path) ? [elementPathOf(r.path)!] : [])))
  const patterns = removed.map((r) => {
    const v = r.value as Row
    const name = typeof v?.name === "string" ? v.name : typeof v?.term === "string" ? v.term : undefined
    return { path: r.path, res: mentionNames(ELEMENT.exec(r.path)?.[2], name).map(wordPattern) }
  })
  const out: FoundLocation[] = []
  for (const e of elements) {
    if (out.length >= limit) break
    if (gone.has(e.path) || exclude.has(e.path) || referrers.has(e.path)) continue
    const text = textOf(e.value)
    const hit = patterns.filter((p) => p.res.some((re) => re.test(text)))
    if (!hit.length) continue
    const section_id = sectionOfElement(spine, e.path)
    out.push({
      path: e.path,
      section_id,
      found_by: ["mention"],
      entity_paths: hit.map((h) => h.path),
      owner_step: section_id === "misc" || section_id.startsWith("custom:") ? null : ownerStepOf(section_id, spine)
    })
  }
  return out
}
