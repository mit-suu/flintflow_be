/**
 * section-registry.ts
 * ─────────────────────────────────────────────────────────────────
 * Danh sách section theo template FPT (khoá logic) + bảng ánh xạ field → section 3 cột
 * (srs-spine.md §4) — HỢP ĐỒNG ĐÓNG BĂNG tại M2 (bảng §4).
 *
 * - Section cố định `fixed:*`; section sinh theo dữ liệu `feature:<id>`, `function:<id>`.
 * - `FIELD_SECTION_MAP` chép nguyên văn 34 dòng bảng §4 (Sở hữu / Đọc / Suy dẫn).
 * - `stepsOf(section)` = step sở hữu section (nghịch đảo cột Sở hữu). Chưa có step registry T12
 *   nên dùng bảng tạm theo Phases §6.4 (`assets/skills/action/deterministic-check/references/red-rules.md`).
 *
 * Không lưu status/số hiệu section — status là hàm tính (`section-status.ts`), số hiệu do assemble (T15).
 */

import type { Spine } from "./spine.types.js"
import { isRecord, parsePath } from "./path-resolver.js"

export interface SectionDef {
  id: string
  title_en: string
  /** Bất biến 1: không xoá được, tính vào điểm sẵn sàng (trừ derived). */
  required: boolean
  /** `fixed:I`, `fixed:5.5` — nội dung tính lại từ Spine, không stale, không tính điểm (§4.2). */
  derived: boolean
  level: number
  order: number
  /** Số hiệu heading cha (`"2.2"`) hoặc `feature:<id>` với function. */
  parent?: string
}

type Def = Omit<SectionDef, "order">

const FIXED_DEFS: Def[] = [
  { id: "fixed:I", title_en: "Record of Changes", required: false, derived: true, level: 1 },
  { id: "fixed:1", title_en: "Product Overview", required: true, derived: false, level: 1 },
  { id: "fixed:2.1", title_en: "Actors", required: true, derived: false, level: 2, parent: "2" },
  { id: "fixed:2.2.1", title_en: "Use Case Diagram", required: true, derived: false, level: 3, parent: "2.2" },
  { id: "fixed:2.2.2", title_en: "Use Case Descriptions", required: true, derived: false, level: 3, parent: "2.2" },
  { id: "fixed:3.1.1", title_en: "Screens Flow", required: true, derived: false, level: 3, parent: "3.1" },
  { id: "fixed:3.1.2", title_en: "Screen Descriptions", required: true, derived: false, level: 3, parent: "3.1" },
  { id: "fixed:3.1.3", title_en: "Screen Authorization", required: true, derived: false, level: 3, parent: "3.1" },
  { id: "fixed:3.1.4", title_en: "Non-Screen Functions", required: true, derived: false, level: 3, parent: "3.1" },
  { id: "fixed:3.1.5", title_en: "Entity Relationship Diagram", required: true, derived: false, level: 3, parent: "3.1" },
  { id: "fixed:4.1", title_en: "External Interfaces", required: true, derived: false, level: 2, parent: "4" },
  { id: "fixed:4.2.1", title_en: "Usability", required: true, derived: false, level: 3, parent: "4.2" },
  { id: "fixed:4.2.2", title_en: "Reliability", required: true, derived: false, level: 3, parent: "4.2" },
  { id: "fixed:4.2.3", title_en: "Performance", required: true, derived: false, level: 3, parent: "4.2" },
  { id: "fixed:4.2.4", title_en: "Domain-Specific Attributes", required: false, derived: false, level: 3, parent: "4.2" },
  { id: "fixed:5.1", title_en: "Business Rules", required: true, derived: false, level: 2, parent: "5" },
  { id: "fixed:5.2", title_en: "Common Requirements", required: true, derived: false, level: 2, parent: "5" },
  { id: "fixed:5.3", title_en: "Application Messages List", required: true, derived: false, level: 2, parent: "5" },
  { id: "fixed:5.4", title_en: "Other Requirements", required: true, derived: false, level: 2, parent: "5" },
  { id: "fixed:5.5", title_en: "Glossary", required: true, derived: true, level: 2, parent: "5" }
]

export const FIXED_SECTIONS: readonly SectionDef[] = Object.freeze(FIXED_DEFS.map((d, order) => ({ ...d, order })))

export const FIXED_SECTION_ID_LIST: readonly string[] = Object.freeze(FIXED_SECTIONS.map((s) => s.id))

/** Bất biến 1 — section cố định bắt buộc (không gồm `fixed:4.2.4`, `fixed:I`). */
export const REQUIRED_FIXED_SECTION_IDS: readonly string[] = Object.freeze(
  FIXED_SECTIONS.filter((s) => s.required).map((s) => s.id)
)

export const DERIVED_SECTION_IDS: ReadonlySet<string> = new Set(FIXED_SECTIONS.filter((s) => s.derived).map((s) => s.id))

/** Feature/function chen giữa §3.1 và §4. */
const FEATURES_AFTER = "fixed:3.1.5"

/** Toàn bộ section của Spine theo thứ tự FPT, mở rộng `feature:*`/`function:*` theo dữ liệu. */
export const listSections = (spine: Spine): SectionDef[] => {
  const split = FIXED_DEFS.findIndex((s) => s.id === FEATURES_AFTER) + 1
  const out: Def[] = [...FIXED_DEFS.slice(0, split)]
  const listed = new Set<string>()

  const pushFunction = (fn: Spine["functions"][number]) => {
    const id = `function:${fn.id}`
    if (listed.has(id)) return
    listed.add(id)
    out.push({ id, title_en: fn.name, required: true, derived: false, level: 3, parent: `feature:${fn.feature_id}` })
  }

  for (const feature of [...spine.features].sort((a, b) => a.order - b.order)) {
    out.push({ id: `feature:${feature.id}`, title_en: feature.name, required: true, derived: false, level: 2, parent: "3" })
    spine.functions
      .filter((fn) => fn.feature_id === feature.id)
      .sort((a, b) => Number(a.screen_id === null) - Number(b.screen_id === null) || a.order - b.order)
      .forEach(pushFunction)
  }
  // function có feature_id chết (dữ liệu lỗi từ trước) vẫn phải liệt kê để không ẩn im lặng
  spine.functions.forEach(pushFunction)

  out.push(...FIXED_DEFS.slice(split))
  return out.map((s, order) => ({ ...s, order }))
}

// ─── bảng §4 ─────────────────────────────────────────────────────

/**
 * Tham chiếu section trong bảng:
 *   `fixed:*`                      section cố định
 *   `feature:<id>` / `function:<id>`  section của chính phần tử
 *   `function:<screen>`            function của màn (screens đọc ra `function:<id>`)
 *   `function:<rule>`              function có `business_rule_ids` chứa rule
 *   `<diagram.section>`            section của chính diagram (screen_layout → `function:<primary_function_id>`)
 *   `diagram:<kind>`               section của diagram kind đó (cột Suy dẫn)
 */
export interface FieldSectionRow {
  key: string
  /** Tên field y như cột Field của bảng §4. */
  field: string
  owner: readonly string[]
  reads: readonly string[]
  derived: readonly string[]
  /** Suy dẫn không ra section (đánh số lúc assemble). */
  note?: string
}

const row = (key: string, field: string, owner: string[], reads: string[] = [], derived: string[] = [], note?: string): FieldSectionRow =>
  Object.freeze({ key, field, owner, reads, derived, ...(note ? { note } : {}) })

export const FIELD_SECTION_MAP: readonly FieldSectionRow[] = Object.freeze([
  row("project_core", "project.vision, .goals[], .name", ["fixed:1"]),
  row("release_scope", "project.release_scope", ["fixed:1"]),
  row("project_class", "project.type, .domain, .complexity, .stakes", [], [], ["fixed:4.2.1", "fixed:4.2.2", "fixed:4.2.3", "fixed:4.2.4"]),
  row("br_high", "business_rules[tier=high]", ["fixed:1"]),
  row("actors_nonhuman", "actors[kind≠human]", ["fixed:1"], ["fixed:2.1"], ["diagram:context"]),
  row("actors", "actors[]", ["fixed:2.1"], ["fixed:2.2.2", "fixed:3.1.3"], ["diagram:usecase", "fixed:5.5"]),
  row("roles_permissions", "roles[], permissions[]", ["fixed:3.1.3"]),
  row("use_cases", "use_cases[]", ["fixed:2.2.2"], [], ["diagram:usecase"]),
  row("features", "features[]", ["feature:<id>"], ["fixed:3.1.2"], [], "số mục §3.x (assemble)"),
  row("screens_desc", "screens[].name/.description/.feature_id", ["fixed:3.1.2"], ["fixed:3.1.1", "fixed:3.1.3", "function:<screen>"], ["diagram:screen_flow", "fixed:5.5"]),
  row("screens_flow", "screens[].flow_to[]/.is_popup/.tabs[]", ["fixed:3.1.1"], [], ["diagram:screen_flow"]),
  row("screens_primary", "screens[].primary_function_id", [], [], ["diagram:screen_layout"]),
  row("functions_screen", "functions[screen_id≠null]", ["function:<id>"], ["fixed:3.1.2", "fixed:2.2.2"]),
  row("functions_nonscreen", "functions[screen_id=null]", ["function:<id>"], ["fixed:3.1.4", "fixed:2.2.2"]),
  row("functions_order", "functions[].order", [], [], [], "số mục §3.x.y (assemble)"),
  row("functions_validations", "functions[].validations[]", ["function:<id>"], [], ["fixed:5.1"]),
  row("functions_abnormal", "functions[].abnormal[]", ["function:<id>"], [], ["fixed:5.3"]),
  row("entities", "entities[]", ["fixed:3.1.5"], [], ["diagram:erd", "fixed:5.5"]),
  row("nfr_interface", "nfrs[category=interface]", ["fixed:4.1"]),
  row("nfr_usability", "nfrs[category=usability]", ["fixed:4.2.1"]),
  row("nfr_reliability", "nfrs[category=reliability]", ["fixed:4.2.2"]),
  row("nfr_performance", "nfrs[category=performance]", ["fixed:4.2.3"]),
  row("nfr_other", "nfrs[category=other]", ["fixed:4.2.4"]),
  row("br_detail", "business_rules[tier=detail]", ["fixed:5.1"], ["function:<rule>"]),
  row("common_requirements", "common_requirements[]", ["fixed:5.2"]),
  row("messages", "messages[]", ["fixed:5.3"]),
  row("other_requirements", "other_requirements[]", ["fixed:5.4"]),
  row("glossary", "glossary[]", ["fixed:5.5"]),
  row("changes", "changes[]", ["fixed:I"]),
  row("diagram_context", "diagrams[kind=context]", ["fixed:1"]),
  row("diagram_usecase", "diagrams[kind=usecase]", ["fixed:2.2.1"]),
  row("diagram_screen_flow", "diagrams[kind=screen_flow]", ["fixed:3.1.1"]),
  row("diagram_erd", "diagrams[kind=erd]", ["fixed:3.1.5"]),
  row("diagram_screen_layout", "diagrams[kind=screen_layout]", ["<diagram.section>"])
])

const ROW: Readonly<Record<string, FieldSectionRow>> = Object.fromEntries(FIELD_SECTION_MAP.map((r) => [r.key, r]))

const NFR_ROW: Readonly<Record<string, string>> = {
  interface: "nfr_interface",
  usability: "nfr_usability",
  reliability: "nfr_reliability",
  performance: "nfr_performance",
  other: "nfr_other"
}

interface Target {
  root: string
  id: string | null
  sub: string | null
  element: Record<string, unknown> | null
}

const rowsOf = (keys: string[]): FieldSectionRow[] => keys.map((k) => ROW[k])

const matchRows = (t: Target): FieldSectionRow[] => {
  const el = t.element
  switch (t.root) {
    case "project":
      if (t.sub === "name" || t.sub === "vision" || t.sub === "goals") return rowsOf(["project_core"])
      if (t.sub === "release_scope") return rowsOf(["release_scope"])
      if (t.sub === "type" || t.sub === "domain" || t.sub === "complexity" || t.sub === "stakes") return rowsOf(["project_class"])
      if (t.sub === null) return rowsOf(["project_core", "release_scope", "project_class"])
      return []
    case "business_rules":
      if (el?.tier === "high") return rowsOf(["br_high"])
      if (el?.tier === "detail") return rowsOf(["br_detail"])
      return rowsOf(["br_high", "br_detail"])
    case "actors":
      return el !== null && el.kind !== "human" ? rowsOf(["actors_nonhuman", "actors"]) : rowsOf(["actors"])
    case "roles":
    case "permissions":
      return rowsOf(["roles_permissions"])
    case "use_cases":
      return rowsOf(["use_cases"])
    case "features":
      return t.sub === "order" ? [] : rowsOf(["features"])
    case "screens":
      if (t.sub === null) return rowsOf(["screens_desc", "screens_flow", "screens_primary"])
      if (t.sub === "name" || t.sub === "description" || t.sub === "feature_id") return rowsOf(["screens_desc"])
      if (t.sub === "flow_to" || t.sub === "is_popup" || t.sub === "tabs") return rowsOf(["screens_flow"])
      if (t.sub === "primary_function_id") return rowsOf(["screens_primary"])
      return []
    case "functions": {
      const base = el !== null && el.screen_id === null ? "functions_nonscreen" : "functions_screen"
      if (t.sub === null) return rowsOf([base, "functions_validations", "functions_abnormal"])
      if (t.sub === "order") return []
      // `priority` (MoSCoW, S-9.4) cùng loại với `order`: siêu dữ liệu render thành một cột, không đổi
      // nội dung section nào. Nếu ánh xạ nó vào dòng chung `functions_*` thì S-9.4 — bước gần cuối,
      // ghi priority cho MỌI function — lập tức làm mọi section đọc `functions[]` thành `stale`, và
      // `section_stale_at_baseline` chặn chính cái baseline ngay sau đó (đo được: 62 cờ đỏ trên fixture
      // 19 màn). Xem docs/spec-gaps.md, dòng T19.
      if (t.sub === "priority") return []
      if (t.sub === "validations") return rowsOf(["functions_validations"])
      if (t.sub === "abnormal") return rowsOf(["functions_abnormal"])
      return rowsOf([base])
    }
    case "entities":
      return rowsOf(["entities"])
    case "nfrs": {
      if (t.sub === "priority") return [] // như functions[].priority — cột MoSCoW, không đổi nội dung
      const key = typeof el?.category === "string" ? NFR_ROW[el.category] : undefined
      return key ? rowsOf([key]) : rowsOf(Object.values(NFR_ROW))
    }
    case "common_requirements":
      return rowsOf(["common_requirements"])
    case "messages":
      return rowsOf(["messages"])
    case "other_requirements":
      return rowsOf(["other_requirements"])
    case "glossary":
      return rowsOf(["glossary"])
    case "diagrams": {
      const kind = typeof el?.kind === "string" ? el.kind : null
      return kind && ROW[`diagram_${kind}`] ? rowsOf([`diagram_${kind}`]) : []
    }
    default:
      return []
  }
}

const resolveRef = (spine: Spine, ref: string, t: Target): string[] => {
  switch (ref) {
    case "feature:<id>":
      return t.id ? [`feature:${t.id}`] : []
    case "function:<id>":
      return t.id ? [`function:${t.id}`] : []
    case "function:<screen>":
      return spine.functions.filter((f) => f.screen_id === t.id).map((f) => `function:${f.id}`)
    case "function:<rule>":
      return spine.functions.filter((f) => t.id !== null && f.business_rule_ids.includes(t.id)).map((f) => `function:${f.id}`)
    case "<diagram.section>":
      return typeof t.element?.section === "string" ? [t.element.section] : []
    default:
      if (ref.startsWith("diagram:")) {
        const kind = ref.slice("diagram:".length)
        return spine.diagrams
          .filter((d) => d.kind === kind && (kind !== "screen_layout" || t.root !== "screens" || d.owner_id === t.id))
          .map((d) => d.section)
      }
      return [ref]
  }
}

export interface SectionImpact {
  owner: string[]
  reads: string[]
  derived: string[]
}

/** `before`/`value` của change, dùng khi phần tử đã bị xoá khỏi Spine hiện tại. */
export interface ChangeHint {
  before?: unknown
  value?: unknown
}

const pickObject = (value: unknown): Record<string, unknown> | null =>
  isRecord(value) && !("_absent" in value) ? value : null

const findElement = (spine: Spine, root: string, id: string | null): Record<string, unknown> | null => {
  if (id === null) return null
  const arr: unknown = (spine as unknown as Record<string, unknown>)[root]
  if (!Array.isArray(arr)) return null
  const found: unknown = arr.find((el) => isRecord(el) && el.id === id)
  return isRecord(found) ? found : null
}

const EMPTY_IMPACT = (): SectionImpact => ({ owner: [], reads: [], derived: [] })

/**
 * Section bị ảnh hưởng khi field ở `path` đổi, theo 3 cột bảng §4, id concrete.
 * Path không ánh xạ (progress, steps, flags, assumptions, addendum…) ⇒ rỗng. `$` ⇒ mọi section.
 */
export const sectionsOfPath = (spine: Spine, path: string, hint: ChangeHint = {}): SectionImpact => {
  if (path === "$") return { owner: listSections(spine).map((s) => s.id), reads: [], derived: [] }

  let segments
  try {
    segments = parsePath(path)
  } catch {
    return EMPTY_IMPACT()
  }
  const [head, next] = segments
  const id = head.selector?.kind === "match" ? (head.selector.pairs.find(([k]) => k === "id")?.[1] ?? null) : null
  // Mục riêng của template người dùng (FLF-182): mỗi phần tử là một section `custom:<id>`, không ảnh hưởng section khác
  if (head.key === "custom_sections") {
    const own = id ?? pickObject(hint.value)?.id ?? pickObject(hint.before)?.id
    return { owner: typeof own === "string" ? [`custom:${own}`] : [], reads: [], derived: [] }
  }
  const element = findElement(spine, head.key, id) ?? pickObject(hint.value) ?? pickObject(hint.before)
  const target: Target = { root: head.key, id, sub: next?.key ?? null, element }

  const impact = EMPTY_IMPACT()
  for (const r of matchRows(target)) {
    for (const column of ["owner", "reads", "derived"] as const) {
      for (const ref of r[column]) impact[column].push(...resolveRef(spine, ref, target))
    }
  }
  return { owner: [...new Set(impact.owner)], reads: [...new Set(impact.reads)], derived: [...new Set(impact.derived)] }
}

/** Alias theo tên trong task 09. */
export const sectionsOf = sectionsOfPath

// ─── step sở hữu section ─────────────────────────────────────────

const range = (phase: string, from: number, to: number): string[] =>
  Array.from({ length: to - from + 1 }, (_, i) => `${phase}.${from + i}`)

/** Bảng tạm (trước T12): section cố định → step sở hữu, Phases §6.4 cột "Ra SRS". */
export const FIXED_OWNER_STEPS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "fixed:I": ["S-8.3"],
  "fixed:1": range("S-2", 1, 5),
  "fixed:2.1": ["S-3.1"],
  "fixed:2.2.1": ["S-3.6"],
  "fixed:2.2.2": range("S-3", 2, 5),
  "fixed:3.1.1": ["S-4.2"],
  "fixed:3.1.2": ["S-4.1"],
  "fixed:3.1.3": ["S-4.3"],
  "fixed:3.1.4": ["S-4.4"],
  "fixed:3.1.5": ["S-4.5"],
  "fixed:4.1": ["S-6.1"],
  "fixed:4.2.1": ["S-6.2"],
  "fixed:4.2.2": ["S-6.3"],
  "fixed:4.2.3": ["S-6.4"],
  "fixed:4.2.4": ["S-6.5"],
  "fixed:5.1": ["S-7.1"],
  "fixed:5.2": ["S-7.2"],
  "fixed:5.3": ["S-7.3"],
  "fixed:5.4": ["S-7.4"],
  "fixed:5.5": ["S-8.1"]
})

export const FEATURE_OWNER_STEPS: readonly string[] = Object.freeze(["S-4.1"])
/** Function section do vòng S-5 của màn chứa nó sở hữu (S-5.2 mô tả, S-5.4 chi tiết). */
export const FUNCTION_OWNER_STEP_TEMPLATES: readonly string[] = Object.freeze(["S-5.2", "S-5.4"])

/** Khoá vòng S-5 của function: screen_id hoặc `nonscreen`. */
export const loopKeyOfFunction = (spine: Spine, functionId: string): string | null => {
  const fn = spine.functions.find((f) => f.id === functionId)
  return fn ? (fn.screen_id ?? "nonscreen") : null
}

/** Step sở hữu section — `steps_of(s)` của srs-spine.md §5. Không có spine ⇒ function trả template chưa gắn @. */
export const stepsOf = (sectionId: string, spine?: Spine): string[] => {
  if (sectionId.startsWith("feature:")) return [...FEATURE_OWNER_STEPS]
  if (sectionId.startsWith("function:")) {
    const key = spine ? loopKeyOfFunction(spine, sectionId.slice("function:".length)) : null
    return FUNCTION_OWNER_STEP_TEMPLATES.map((t) => (key ? `${t}@${key}` : t))
  }
  return [...(FIXED_OWNER_STEPS[sectionId] ?? [])]
}

/** Step đầu tiên sở hữu section — dùng làm `remediation_step`. */
export const ownerStepOf = (sectionId: string, spine?: Spine): string => stepsOf(sectionId, spine)[0] ?? "S-9.1"
