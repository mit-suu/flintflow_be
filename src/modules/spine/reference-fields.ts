/**
 * reference-fields.ts
 * ─────────────────────────────────────────────────────────────────
 * Danh sách quyền uy `reference_fields[]` (srs-spine.md §4.1).
 * Dùng chung cho: impact query (T17) · bất biến 3 (T08) · cờ đỏ `dead_reference` (T09).
 * Ba nơi phải đọc CÙNG danh sách này, không chép tay.
 *
 * Diễn giải đã chọn (ghi ở docs/spec-gaps.md):
 * - Khoá section (`sections[].id`, `addendum[].target_section`, `flags[].section_id`) "tồn tại"
 *   khi phân giải được: `fixed:*` thuộc danh sách section cố định của template FPT,
 *   `feature:<id>` / `function:<id>` có phần tử tương ứng. Không đòi có mặt trong `sections[]`
 *   (Spine mới có `sections[]` rỗng nhưng addendum đã trỏ `fixed:5.4`).
 *   Riêng `addendum[].target_section` chỉ cần đúng dạng: entry Brief được trỏ `feature:F3` trước khi
 *   feature được sinh (fixture minimal).
 * - `diagrams[].owner_id` trỏ theo `owner_kind` (screen/feature/function/actor/entity); kind khác bỏ qua.
 * - `steps[].id` chỉ phần sau `@`, trừ `@nonscreen`.
 */

import type { Spine } from "./spine.types.js"
import { tryResolve } from "./path-resolver.js"
import { FIXED_SECTION_ID_LIST } from "./section-registry.js"

export type TargetCollection =
  | "actors"
  | "use_cases"
  | "functions"
  | "features"
  | "screens"
  | "roles"
  | "business_rules"
  | "entities"
  | "validations"
  | "custom_sections"
  | "section_key"
  | "path"
  | "diagram_owner"

export interface ReferenceField {
  /** Tên field theo §4.1, ví dụ `use_cases[].actor_ids[]`. */
  path: string
  targetCollection: TargetCollection
  cardinality: "one" | "many"
}

export const REFERENCE_FIELDS: readonly ReferenceField[] = Object.freeze([
  { path: "use_cases[].actor_ids[]", targetCollection: "actors", cardinality: "many" },
  { path: "use_cases[].function_ids[]", targetCollection: "functions", cardinality: "many" },
  { path: "use_cases[].includes[]", targetCollection: "use_cases", cardinality: "many" },
  { path: "use_cases[].extends[]", targetCollection: "use_cases", cardinality: "many" },
  { path: "screens[].feature_id", targetCollection: "features", cardinality: "one" },
  { path: "screens[].flow_to[]", targetCollection: "screens", cardinality: "many" },
  { path: "screens[].primary_function_id", targetCollection: "functions", cardinality: "one" },
  { path: "permissions[].screen_id", targetCollection: "screens", cardinality: "one" },
  { path: "permissions[].role_id", targetCollection: "roles", cardinality: "one" },
  { path: "roles[].actor_id", targetCollection: "actors", cardinality: "one" },
  { path: "functions[].screen_id", targetCollection: "screens", cardinality: "one" },
  { path: "functions[].feature_id", targetCollection: "features", cardinality: "one" },
  { path: "functions[].business_rule_ids[]", targetCollection: "business_rules", cardinality: "many" },
  { path: "entities[].relations[]", targetCollection: "entities", cardinality: "many" },
  { path: "business_rules[].source_validation_ids[]", targetCollection: "validations", cardinality: "many" },
  { path: "messages[].function_ids[]", targetCollection: "functions", cardinality: "many" },
  { path: "diagrams[].owner_id", targetCollection: "diagram_owner", cardinality: "one" },
  { path: "addendum[].target_section", targetCollection: "section_key", cardinality: "one" },
  { path: "flags[].section_id", targetCollection: "section_key", cardinality: "one" },
  { path: "assumptions[].path", targetCollection: "path", cardinality: "one" },
  { path: "sections[].id", targetCollection: "section_key", cardinality: "one" },
  { path: "progress.screen_cursor", targetCollection: "screens", cardinality: "one" },
  { path: "progress.screen_queue[]", targetCollection: "screens", cardinality: "many" },
  { path: "steps[].id", targetCollection: "screens", cardinality: "one" }
] as const satisfies readonly ReferenceField[])

/** Section cố định của template FPT — từ section registry (T09). */
export const FIXED_SECTION_IDS: readonly string[] = FIXED_SECTION_ID_LIST

const FIXED_SECTION_SET = new Set(FIXED_SECTION_IDS)

/** `owner_kind` của diagram → collection đích. */
export const DIAGRAM_OWNER_COLLECTIONS: Readonly<Record<string, Exclude<TargetCollection, "section_key" | "path" | "diagram_owner">>> =
  Object.freeze({
    screen: "screens",
    feature: "features",
    function: "functions",
    actor: "actors",
    entity: "entities"
  })

// ─── id index ────────────────────────────────────────────────────

export type IdCollection = Exclude<TargetCollection, "section_key" | "path" | "diagram_owner">

export type IdIndex = Record<IdCollection, Set<string>>

const ids = (arr: { id: string }[]): Set<string> => new Set(arr.map((x) => x.id))

export const buildIdIndex = (spine: Spine): IdIndex => ({
  actors: ids(spine.actors),
  use_cases: ids(spine.use_cases),
  functions: ids(spine.functions),
  features: ids(spine.features),
  screens: ids(spine.screens),
  roles: ids(spine.roles),
  business_rules: ids(spine.business_rules),
  entities: ids(spine.entities),
  validations: new Set(spine.functions.flatMap((f) => f.validations.map((v) => v.id))),
  custom_sections: ids(spine.custom_sections)
})

/** `fixed:3.1.1` → hợp lệ nếu thuộc template; `feature:F1` / `function:FN01` → phần tử tồn tại. */
export const sectionKeyExists = (index: IdIndex, sectionId: string): boolean => {
  if (FIXED_SECTION_SET.has(sectionId)) return true
  if (sectionId.startsWith("feature:")) return index.features.has(sectionId.slice("feature:".length))
  if (sectionId.startsWith("function:")) return index.functions.has(sectionId.slice("function:".length))
  if (sectionId.startsWith("custom:")) return index.custom_sections.has(sectionId.slice("custom:".length))
  return false
}

// ─── iterate ─────────────────────────────────────────────────────

export interface ReferenceHit {
  field: ReferenceField
  /** Path tới phần tử chứa khoá, ví dụ `use_cases[id=UC01]`; `progress` cho field của progress. */
  ownerPath: string
  /** Path concrete tới chính khoá: `use_cases[id=UC01].actor_ids[=A08]`, `screens[id=S01].feature_id`. */
  refPath: string
  /** Giá trị khoá (id, section key, hoặc path với `assumptions[].path`). */
  targetId: string
  /** Collection đích sau khi giải `owner_kind` (với `diagram_owner`). */
  target: TargetCollection
}

export function* iterateReferences(spine: Spine): Generator<ReferenceHit> {
  const [
    ucActors,
    ucFunctions,
    ucIncludes,
    ucExtends,
    screenFeature,
    screenFlow,
    screenPrimary,
    permScreen,
    permRole,
    roleActor,
    fnScreen,
    fnFeature,
    fnRules,
    entityRelations,
    ruleValidations,
    messageFunctions,
    diagramOwner,
    addendumSection,
    flagSection,
    assumptionPath,
    sectionId,
    cursor,
    queue,
    stepId
  ] = REFERENCE_FIELDS

  const many = function* (field: ReferenceField, ownerPath: string, key: string, values: string[]) {
    for (const v of values) yield { field, ownerPath, refPath: `${ownerPath}.${key}[=${v}]`, targetId: v, target: field.targetCollection }
  }
  const one = (field: ReferenceField, ownerPath: string, key: string, value: string, target = field.targetCollection): ReferenceHit => ({
    field,
    ownerPath,
    refPath: `${ownerPath}.${key}`,
    targetId: value,
    target
  })

  for (const uc of spine.use_cases) {
    const owner = `use_cases[id=${uc.id}]`
    yield* many(ucActors, owner, "actor_ids", uc.actor_ids)
    yield* many(ucFunctions, owner, "function_ids", uc.function_ids)
    yield* many(ucIncludes, owner, "includes", uc.includes)
    yield* many(ucExtends, owner, "extends", uc.extends)
  }
  for (const s of spine.screens) {
    const owner = `screens[id=${s.id}]`
    yield one(screenFeature, owner, "feature_id", s.feature_id)
    yield* many(screenFlow, owner, "flow_to", s.flow_to)
    if (s.primary_function_id !== null) yield one(screenPrimary, owner, "primary_function_id", s.primary_function_id)
  }
  for (const p of spine.permissions) {
    const owner = `permissions[id=${p.id}]`
    yield one(permScreen, owner, "screen_id", p.screen_id)
    yield one(permRole, owner, "role_id", p.role_id)
  }
  for (const r of spine.roles) {
    if (r.actor_id !== null) yield one(roleActor, `roles[id=${r.id}]`, "actor_id", r.actor_id)
  }
  for (const f of spine.functions) {
    const owner = `functions[id=${f.id}]`
    if (f.screen_id !== null) yield one(fnScreen, owner, "screen_id", f.screen_id)
    yield one(fnFeature, owner, "feature_id", f.feature_id)
    yield* many(fnRules, owner, "business_rule_ids", f.business_rule_ids)
  }
  for (const e of spine.entities) yield* many(entityRelations, `entities[id=${e.id}]`, "relations", e.relations)
  for (const br of spine.business_rules) {
    yield* many(ruleValidations, `business_rules[id=${br.id}]`, "source_validation_ids", br.source_validation_ids)
  }
  for (const m of spine.messages) yield* many(messageFunctions, `messages[id=${m.id}]`, "function_ids", m.function_ids)
  for (const d of spine.diagrams) {
    const target = d.owner_kind === null ? undefined : DIAGRAM_OWNER_COLLECTIONS[d.owner_kind]
    if (d.owner_id !== null && target) yield one(diagramOwner, `diagrams[id=${d.id}]`, "owner_id", d.owner_id, target)
  }
  for (const a of spine.addendum) yield one(addendumSection, `addendum[id=${a.id}]`, "target_section", a.target_section)
  for (const fl of spine.flags) yield one(flagSection, `flags[id=${fl.id}]`, "section_id", fl.section_id)
  for (const as of spine.assumptions) yield one(assumptionPath, `assumptions[id=${as.id}]`, "path", as.path)
  for (const sec of spine.sections) {
    const owner = `sections[id=${sec.id}]`
    yield { field: sectionId, ownerPath: owner, refPath: owner, targetId: sec.id, target: "section_key" }
  }
  if (spine.progress.screen_cursor !== null) yield one(cursor, "progress", "screen_cursor", spine.progress.screen_cursor)
  yield* many(queue, "progress", "screen_queue", spine.progress.screen_queue)
  for (const st of spine.steps) {
    const at = st.id.indexOf("@")
    if (at < 0) continue
    const screenId = st.id.slice(at + 1)
    if (screenId === "nonscreen") continue
    const owner = `steps[id=${st.id}]`
    yield { field: stepId, ownerPath: owner, refPath: owner, targetId: screenId, target: "screens" }
  }
}

/** Khoá section đúng dạng: `fixed:*` của template, hoặc `feature:<id>` / `function:<id>` / `custom:<id>` (FLF-182) bất kỳ. */
export const sectionKeyWellFormed = (sectionId: string): boolean =>
  FIXED_SECTION_SET.has(sectionId) || /^(feature|function|custom):\S+$/.test(sectionId)

/** Khoá của `hit` còn trỏ tới phần tử tồn tại không. */
export const referenceAlive = (spine: Spine, index: IdIndex, hit: ReferenceHit): boolean => {
  switch (hit.target) {
    case "section_key":
      // Entry addendum ghi ở Brief trỏ section chưa sinh (feature:F3 trước S-4.1) — hợp lệ, chỉ cần đúng dạng
      if (hit.field.path === "addendum[].target_section") return sectionKeyWellFormed(hit.targetId)
      return sectionKeyExists(index, hit.targetId)
    case "path":
      return tryResolve(spine, hit.targetId) !== null
    case "diagram_owner":
      return true
    default:
      return index[hit.target].has(hit.targetId)
  }
}

/** Mọi khoá chết — bất biến 3 và cờ đỏ `dead_reference`. */
export const findDeadReferences = (spine: Spine): ReferenceHit[] => {
  const index = buildIdIndex(spine)
  return [...iterateReferences(spine)].filter((hit) => !referenceAlive(spine, index, hit))
}
