/**
 * Vị trí của change request trên Spine (mode 1 v2 — FLF-186, plan v2 §8, D1): đơn vị là **phần tử Spine** (`project`,
 * `actors[id=A01]`, `custom_sections[id=CS02]`…) thay cho block của file docx. Hàm thuần — không DB.
 * - C-3 tìm: phần tử đích của C-2 + phần tử đang tham chiếu tới nó (`spine_link`), phần tử nhắc mã/tên của đích
 *   (`mention`), phần tử chứa từ khoá (`keyword`) — theo ranh giới từ, không phân biệt hoa thường.
 * - Giá trị của vị trí được chụp thành chuỗi ổn định (`valueText`): C-5 so với Spine hiện tại để biết phần tử đã bị
 *   sửa ở chỗ khác kể từ lúc đề xuất (thay "old text khớp block" của bản theo block).
 */

import { impactOf } from "../spine/impact.service.js"
import { ownerStepOf, sectionsOfPath } from "../spine/section-registry.js"
import type { Spine } from "../spine/spine.types.js"
import type { LocationFoundBy } from "./change-request.constants.js"

/** Trần số vị trí một CR — CR chạm quá nhiều chỗ nên tách nhỏ. */
export const MAX_LOCATIONS = 80

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
  "custom_sections"
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

type Row = Record<string, unknown>

const arrayOf = (spine: Spine, key: string): Row[] => {
  const value = (spine as unknown as Record<string, unknown>)[key]
  return Array.isArray(value) ? (value as Row[]) : []
}

/** Giá trị hiện tại của phần tử — `undefined` nếu không còn. */
export const elementValue = (spine: Spine, path: string): unknown => {
  if (path === PROJECT_PATH) return spine.project
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

/** Mọi chuỗi trong giá trị, nối lại — để tìm từ khoá / mã / tên. */
const textOf = (value: unknown): string => {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(textOf).join("\n")
  if (value && typeof value === "object") return Object.values(value as Row).map(textOf).join("\n")
  return ""
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const wordPattern = (s: string): RegExp => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(s)}(?![\\p{L}\\p{N}])`, "iu")

/** Section chứa phần tử (ưu tiên section sở hữu). Không ra section ⇒ `misc`. */
export const sectionOfElement = (spine: Spine, path: string): string => {
  if (path === PROJECT_PATH) return "fixed:1"
  const impact = sectionsOfPath(spine, path)
  return impact.owner[0] ?? impact.reads[0] ?? "misc"
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
}

/**
 * C-3: gom vị trí từ đích C-2 (`targets` — path phần tử hoặc field) và từ khoá. Đích không còn trong Spine bị bỏ.
 */
export const findSpineLocations = (spine: Spine, targets: readonly string[], keywords: readonly string[]): FoundLocation[] => {
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

  const patterns = keywords
    .map((k) => k.trim())
    .filter((k) => k.length >= 3)
    .map(wordPattern)
  for (const e of elements) if (patterns.some((re) => re.test(textOf(e.value)))) hit(e.path, "keyword")

  return elements
    .filter((e) => hits.has(e.path))
    .slice(0, MAX_LOCATIONS)
    .map((e) => {
      const h = hits.get(e.path)!
      const section_id = sectionOfElement(spine, e.path)
      return {
        path: e.path,
        section_id,
        found_by: [...h.found_by],
        entity_paths: [...h.entity_paths],
        owner_step: section_id === "misc" || section_id.startsWith("custom:") ? null : ownerStepOf(section_id, spine)
      }
    })
}

/** Đích dạng mã section mà Spine chưa có phần tử nào thuộc về — CR không sửa được gì ở đó, phải chạy step để soạn. */
export const emptySectionTargets = (spine: Spine, targets: readonly string[]): string[] => {
  const sections = [...new Set(targets.filter(isSectionTarget))]
  if (!sections.length) return []
  const filled = new Set(listElements(spine).map((e) => sectionOfElement(spine, e.path)))
  return sections.filter((s) => !filled.has(s))
}

/** Phần tử mà op chạm tới (để đòi khoá): `actors[id=A01].name` ⇒ `actors[id=A01]`; `actors[]` (thêm mới) ⇒ null. */
export const opElement = (opPath: string): string | null => elementPathOf(opPath)
