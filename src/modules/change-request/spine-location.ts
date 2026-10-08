/**
 * Vị trí của change request trên Spine (mode 1 v2 — FLF-186, plan v2 §8, D1): đơn vị là **phần tử Spine** (`project`,
 * `actors[id=A01]`, `custom_sections[id=CS02]`…) thay cho block của file docx. Hàm thuần — không DB.
 * - C-3 tìm: phần tử đích của C-2 + phần tử đang tham chiếu tới nó (`spine_link`), phần tử nhắc mã/tên của đích
 *   (`mention`), phần tử chứa từ khoá (`keyword`) — theo ranh giới từ, không phân biệt hoa thường.
 * - Giá trị của vị trí được chụp thành chuỗi ổn định (`valueText`): C-5 so với Spine hiện tại để biết phần tử đã bị
 *   sửa ở chỗ khác kể từ lúc đề xuất (thay "old text khớp block" của bản theo block).
 */

import { sectionHasData } from "../spine/deterministic-check.js"
import { ORIGINAL_DIAGRAM_DATA, ORIGINAL_DIAGRAM_SECTION, originalDiagramOf } from "../spine/original-diagram.js"
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
  /** Mode 1 v3: cờ đỏ `unconfirmed_assumption` chỉ đóng được bằng CR (không còn S-9.2) ⇒ giả định phải làm được vị trí. */
  "assumptions",
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
        owner_step: section_id === "misc" || section_id.startsWith("custom:") ? null : ownerStepOf(section_id, spine)
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
  // Ô thêm mới và vị trí sơ đồ gốc luôn giữ lại khi phải cắt bớt vị trí
  return [...found.slice(0, Math.max(0, MAX_LOCATIONS - slots.length - extra.length)), ...slots, ...extra]
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
    const kinds = [...new Set(c.blocks.map(originalDiagramOf).flatMap((d) => (d ? [d.kind] : [])))]
    if (!kinds.length) continue
    const path = `custom_sections[id=${c.id}]`
    const hit = kinds.filter(
      (k) =>
        ORIGINAL_DIAGRAM_DATA[k].some((a) => touched.has(a)) ||
        targets.includes(ORIGINAL_DIAGRAM_SECTION[k]) ||
        targets.includes(`custom:${c.id}`) ||
        targets.some((t) => elementPathOf(t) === path)
    )
    if (!hit.length) continue
    out.push({ path, section_id: sectionOfElement(spine, path), found_by: ["diagram"], entity_paths: hit.map((k) => ORIGINAL_DIAGRAM_SECTION[k]), owner_step: null })
  }
  return out
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
  emptySections(spine, targets).filter((s) => fillPathsOfSection(s).length === 0)

/** Phần tử mà op chạm tới (để đòi khoá): `actors[id=A01].name` ⇒ `actors[id=A01]`; `actors[]` (thêm mới) ⇒ null. */
export const opElement = (opPath: string): string | null => elementPathOf(opPath)
