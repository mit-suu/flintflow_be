/**
 * deterministic-check.ts
 * ─────────────────────────────────────────────────────────────────
 * 11 luật cờ đỏ (srs-spine.md §7) + 12 luật vàng (cardinality §8.1, quan hệ và đặt tên use case, tên hệ thống).
 * Hàm thuần trên đồ thị khoá, KHÔNG gọi model. Chỉ cờ đỏ chặn `baselines[]`.
 *
 * Mọi cờ đỏ có `remediation_step` thi hành được. Mọi `section_id` là khoá section phân giải
 * được (flag ghi qua op engine, bất biến 3 chặn khoá chết) — không suy ra được thì dùng `fixed:I`.
 * Luật gắn S-9 (`unconfirmed_assumption`, `*_at_baseline`) chỉ chạy khi `atBaseline`.
 * Luật "chưa có X" chỉ bắn cờ khi bước sinh ra X đã `accepted` (FLF-213, `StepGate` bên dưới).
 */

import type { Change, Diagram, Flag, FlagLevel, Spine } from "./spine.types.js"
import { buildIdIndex, findDeadReferences, sectionKeyExists, type ReferenceHit } from "./reference-fields.js"
import { tryResolve } from "./path-resolver.js"
import { loopKeyOfFunction, ownerStepOf, stepsOf, REQUIRED_FIXED_SECTION_IDS, DERIVED_SECTION_IDS, sectionsOfPath } from "./section-registry.js"
import { computeSectionStates } from "./section-status.js"
import { UNHASHED_SOURCE_HASHES, computeSourceHash } from "./source-hash.js"

export interface RuleDef {
  rule_id: string
  level: FlagLevel
  waivable: boolean
  /** Chỉ chạy ở S-9 (`atBaseline`). */
  at_baseline: boolean
}

const rule = (rule_id: string, level: FlagLevel, waivable: boolean, at_baseline = false): RuleDef =>
  Object.freeze({ rule_id, level, waivable, at_baseline })

export const RULES: readonly RuleDef[] = Object.freeze([
  rule("section_empty", "red", true),
  rule("array_empty", "red", false),
  rule("dead_reference", "red", false),
  rule("render_error", "red", false),
  rule("diagram_stale", "red", true),
  rule("nfr_missing_number", "red", true),
  rule("usecase_relation_invalid", "red", true),
  rule("unconfirmed_assumption", "red", true, true),
  rule("section_stale_at_baseline", "red", true, true),
  rule("section_awaiting_reaccept", "red", true, true),
  rule("screen_pending_at_baseline", "red", true, true),

  rule("orphan_actor", "yellow", true),
  rule("usecase_no_function", "yellow", true),
  rule("screen_no_function", "yellow", true),
  rule("empty_feature", "yellow", true),
  rule("role_no_actor", "yellow", true),
  rule("non_english_content", "yellow", true),
  rule("usecase_floating", "yellow", true),
  rule("usecase_auth_relation", "yellow", true),
  rule("usecase_name_semantic", "yellow", true),
  rule("usecase_name_style", "yellow", true),
  rule("actor_name_shape", "yellow", true),
  rule("system_name_missing", "yellow", true),
  rule("screen_placeholder", "yellow", true),
  rule("derived_from_changed_assumption", "yellow", true),
  rule("function_without_uc", "yellow", true)
])

/** Ba luật là vi phạm bất biến/lỗi kỹ thuật — waive nghĩa là ký baseline trên Spine gãy (§7). */
export const NON_WAIVABLE_RULES: ReadonlySet<string> = new Set(RULES.filter((r) => !r.waivable).map((r) => r.rule_id))

/**
 * Cờ KHÔNG do deterministic check sinh ra, mà do người hoặc model đặt ở một cổng cụ thể:
 * `accepted_as_is` (gate `accept_as_is`, T13) và `goal_not_covered` (S-9.3 Business Goal Validation, T19).
 *
 * `runDeterministicCheck` không bao giờ trả chúng làm ứng viên, nên nếu không liệt kê ở đây thì lượt
 * recompute kế tiếp sẽ coi là "điều kiện không còn" và tự đóng — nghĩa là cờ biến mất ngay sau bước tiếp
 * theo, không ai kịp đọc. `planFlagOps` bỏ qua chúng khi dọn cờ; muốn đóng thì đóng có chủ đích
 * (user xử lý xong, hoặc bước sở hữu chạy lại và ghi đè).
 */
export const MODEL_OWNED_RULES: ReadonlySet<string> = new Set(["accepted_as_is", "goal_not_covered", "import_semantic", "cr_consistency"])

export interface FlagCandidate {
  level: FlagLevel
  rule_id: string
  section_id: string
  target_id: string | null
  message: string
  remediation_step: string
}

/** Khoá flag: `(level, rule_id, section_id, target_id)` — cùng `resolved_at IS NULL` ở flags.service. */
export const flagKey = (f: Pick<Flag, "level" | "rule_id" | "section_id"> & { target_id?: string | null }): string =>
  `${f.level}|${f.rule_id}|${f.section_id}|${f.target_id ?? ""}`

/**
 * Hồ sơ luật theo cách làm SRS (FLF-171): mode 1 (import) loại các luật vô nghĩa với Spine trích từ tài liệu có sẵn
 * và hạ mức vài luật đỏ xuống vàng (P0 báo cáo §3.1). Không truyền ⇒ chạy đủ luật như mode 2.
 */
export interface RuleProfile {
  exclude: ReadonlySet<string>
  downgrade: ReadonlySet<string>
  /**
   * FLF-213: bỏ cổng "bước sở hữu đã chốt chưa" của các luật "chưa có X". Mode 1 nhận trọn tài liệu một
   * lượt và `steps[]` là SUY RA từ file (mục thiếu ⇒ `pending`), nên mục trống là gap phải báo ngay chứ
   * không phải "chưa tới lượt". Không đặt ⇒ có cổng, như mode 2.
   */
  skipOwnerStepGate?: boolean
}

export interface CheckOptions {
  atBaseline?: boolean
  ruleProfile?: RuleProfile
}

/** Áp hồ sơ luật lên ứng viên cờ (loại trừ trước, rồi hạ đỏ ⇒ vàng). */
export const applyRuleProfile = (candidates: FlagCandidate[], profile: RuleProfile | undefined): FlagCandidate[] =>
  profile
    ? candidates
        .filter((c) => !profile.exclude.has(c.rule_id))
        .map((c) => (profile.downgrade.has(c.rule_id) && c.level === "red" ? { ...c, level: "yellow" as const } : c))
    : candidates

const RENDER_STEP: Readonly<Record<string, string>> = { context: "S-2.5", usecase: "S-3.6", screen_flow: "S-4.2", erd: "S-4.5" }

export const renderStepOf = (d: Pick<Diagram, "kind" | "owner_id">): string =>
  RENDER_STEP[d.kind] ?? (d.owner_id ? `S-5.3@${d.owner_id}` : "S-5.3")

const functionStep = (spine: Spine, functionId: string, template = "S-5.4"): string => {
  const key = loopKeyOfFunction(spine, functionId)
  return key ? `${template}@${key}` : template
}

const NFR_SECTION: Readonly<Record<string, { section: string; step: string }>> = {
  interface: { section: "fixed:4.1", step: "S-6.1" },
  usability: { section: "fixed:4.2.1", step: "S-6.2" },
  reliability: { section: "fixed:4.2.2", step: "S-6.3" },
  performance: { section: "fixed:4.2.3", step: "S-6.4" },
  other: { section: "fixed:4.2.4", step: "S-6.5" }
}

// ─── cổng "bước sở hữu đã chốt chưa" (FLF-213) ───────────────────

/**
 * Luật "chưa có X" chỉ là lỗi khi bước SINH RA X đã chốt mà mục vẫn trống. Không xét bước thì một dự án
 * đang ở S-3.6 lĩnh đủ cờ của §3.1.x (làm ở S-4) và §4.x (S-6): trống ở đó là đúng kế hoạch, nhưng panel
 * đỏ rực vì chúng, vấn đề thật chìm mất và `readiness.red_open` bị thổi phồng.
 *
 * Lượt ký bản (`atBaseline`, S-9) mở hết cổng — tới đó mọi bước phải xong, không mục nào được lọt vì
 * "chưa tới lượt". Mode 1 cũng mở hết (`skipOwnerStepGate`): xem `RuleProfile`.
 */
export interface StepGate {
  /** Mọi step truyền vào đã `accepted` ⇒ cổng mở, mục trống lúc này là lỗi thật. */
  done: (...stepIds: string[]) => boolean
}

/**
 * Bước sinh ra dữ liệu luật đang soi — KHÁC `remediation_step` ở vài luật. "Use case chưa gắn function"
 * sửa ở S-3.2, nhưng `use_cases[].function_ids` chỉ được điền từ S-4.1 (function của màn) và S-4.4
 * (function nền), nên trước khi S-4.4 chốt thì MỌI use case đều "chưa gắn function" — đúng theo kế hoạch.
 */
const GATE_STEP = {
  orphan_actor: "S-3.2",
  usecase_no_function: "S-4.4",
  screen_no_function: "S-4.1",
  empty_feature: "S-4.1",
  role_no_actor: "S-3.1",
  usecase_floating: "S-3.4",
  function_without_uc: "S-4.4"
} as const

const OPEN_GATE: StepGate = { done: () => true }

/** `open` ⇒ cổng mở sẵn (lượt ký bản, mode 1). Ngược lại chỉ `accepted` mới tính là đã chạy qua. */
export const stepGate = (spine: Spine, open: boolean): StepGate => {
  if (open) return OPEN_GATE
  const accepted = new Set(spine.steps.filter((s) => s.status === "accepted").map((s) => s.id))
  return { done: (...ids) => ids.length > 0 && ids.every((id) => accepted.has(id)) }
}

// ─── red: section_empty ──────────────────────────────────────────

const hasKind = (s: Spine, kind: Diagram["kind"]) => s.diagrams.some((d) => d.kind === kind)
const nfrCount = (s: Spine, category: string) => s.nfrs.filter((n) => n.category === category).length

/** "Không field nào có dữ liệu" theo cột Sở hữu bảng §4. */
const SECTION_HAS_DATA: Readonly<Record<string, (s: Spine) => boolean>> = {
  "fixed:1": (s) =>
    Boolean(s.project.vision) ||
    s.project.goals.length > 0 ||
    s.project.release_scope.in.length > 0 ||
    s.project.release_scope.out.length > 0 ||
    s.actors.some((a) => a.kind !== "human") ||
    s.business_rules.some((b) => b.tier === "high") ||
    hasKind(s, "context"),
  "fixed:2.1": (s) => s.actors.length > 0,
  "fixed:2.2.1": (s) => hasKind(s, "usecase"),
  "fixed:2.2.2": (s) => s.use_cases.length > 0,
  "fixed:3.1.1": (s) => s.screens.some((x) => x.flow_to.length > 0 || x.is_popup || x.tabs.length > 0) || hasKind(s, "screen_flow"),
  "fixed:3.1.2": (s) => s.screens.length > 0,
  "fixed:3.1.3": (s) => s.roles.length > 0 || s.permissions.length > 0,
  "fixed:3.1.4": (s) => s.functions.some((f) => f.screen_id === null),
  "fixed:3.1.5": (s) => s.entities.length > 0 || hasKind(s, "erd"),
  "fixed:4.1": (s) => nfrCount(s, "interface") > 0,
  "fixed:4.2.1": (s) => nfrCount(s, "usability") > 0,
  "fixed:4.2.2": (s) => nfrCount(s, "reliability") > 0,
  "fixed:4.2.3": (s) => nfrCount(s, "performance") > 0,
  "fixed:5.1": (s) => s.business_rules.some((b) => b.tier === "detail"),
  "fixed:5.2": (s) => s.common_requirements.length > 0,
  "fixed:5.3": (s) => s.messages.length > 0,
  "fixed:5.4": (s) => s.other_requirements.length > 0
}

const sectionEmpty = (spine: Spine, gate: StepGate): FlagCandidate[] =>
  REQUIRED_FIXED_SECTION_IDS.filter((id) => !DERIVED_SECTION_IDS.has(id))
    .filter((id) => !(SECTION_HAS_DATA[id]?.(spine) ?? true))
    // Mọi step sở hữu phải chốt: §1 do S-2.1…S-2.5 nuôi, chốt mỗi S-2.1 chưa nói lên mục đã xong
    .filter((id) => gate.done(...stepsOf(id, spine)))
    .map((id) => ({
      level: "red",
      rule_id: "section_empty",
      section_id: id,
      target_id: null,
      message: `Section bắt buộc ${id} chưa có dữ liệu`,
      remediation_step: ownerStepOf(id)
    }))

// ─── red: array_empty ────────────────────────────────────────────

const PROTECTED_ARRAYS: readonly { label: string; count: (s: Spine) => number; section: string; step: string }[] = [
  { label: "actors", count: (s) => s.actors.length, section: "fixed:2.1", step: "S-3.1" },
  { label: "actors[kind=human]", count: (s) => s.actors.filter((a) => a.kind === "human").length, section: "fixed:2.1", step: "S-3.1" },
  { label: "screens", count: (s) => s.screens.length, section: "fixed:3.1.2", step: "S-4.1" },
  { label: "entities", count: (s) => s.entities.length, section: "fixed:3.1.5", step: "S-4.5" },
  { label: "use_cases", count: (s) => s.use_cases.length, section: "fixed:2.2.2", step: "S-3.2" },
  { label: "features", count: (s) => s.features.length, section: "fixed:3.1.2", step: "S-4.1" },
  { label: "functions", count: (s) => s.functions.length, section: "fixed:3.1.2", step: "S-4.1" },
  { label: "roles", count: (s) => s.roles.length, section: "fixed:3.1.3", step: "S-3.1" },
  { label: "nfrs[category=reliability]", count: (s) => nfrCount(s, "reliability"), section: "fixed:4.2.2", step: "S-6.3" },
  { label: "nfrs[category=performance]", count: (s) => nfrCount(s, "performance"), section: "fixed:4.2.3", step: "S-6.4" },
  { label: "common_requirements", count: (s) => s.common_requirements.length, section: "fixed:5.2", step: "S-7.2" }
]

const arrayEmpty = (spine: Spine, gate: StepGate): FlagCandidate[] =>
  PROTECTED_ARRAYS.filter((a) => a.count(spine) === 0 && gate.done(a.step)).map((a) => ({
    level: "red",
    rule_id: "array_empty",
    section_id: a.section,
    target_id: a.label,
    message: `${a.label} đang rỗng`,
    remediation_step: a.step
  }))

// ─── red: dead_reference ─────────────────────────────────────────

const ownerIdOf = (hit: ReferenceHit): string | null => /^\w+\[id=([^\]]+)\]/.exec(hit.ownerPath)?.[1] ?? null

type Where = { section: string; step: string }

const deadReferenceWhere = (spine: Spine, hit: ReferenceHit): Where => {
  const owner = ownerIdOf(hit)
  switch (hit.field.path) {
    case "use_cases[].actor_ids[]":
    case "use_cases[].function_ids[]":
      return { section: "fixed:2.2.2", step: "S-3.2" }
    case "use_cases[].includes[]":
    case "use_cases[].extends[]":
      return { section: "fixed:2.2.2", step: "S-3.4" }
    case "screens[].feature_id":
    case "screens[].primary_function_id":
      return { section: "fixed:3.1.2", step: "S-4.1" }
    case "screens[].flow_to[]":
      return { section: "fixed:3.1.1", step: "S-4.2" }
    case "permissions[].screen_id":
    case "permissions[].role_id":
      return { section: "fixed:3.1.3", step: "S-4.3" }
    case "roles[].actor_id":
      return { section: "fixed:3.1.3", step: "S-3.1" }
    case "functions[].screen_id":
    case "functions[].feature_id":
      return { section: `function:${owner}`, step: "S-4.1" }
    case "functions[].business_rule_ids[]":
      return { section: `function:${owner}`, step: owner ? functionStep(spine, owner) : "S-5.4" }
    case "entities[].relations[]":
      return { section: "fixed:3.1.5", step: "S-4.5" }
    case "business_rules[].source_validation_ids[]":
      return { section: "fixed:5.1", step: "S-7.1" }
    case "messages[].function_ids[]":
      return { section: "fixed:5.3", step: "S-7.3" }
    case "diagrams[].owner_id": {
      const d = spine.diagrams.find((x) => x.id === owner)
      return d ? { section: d.section, step: renderStepOf(d) } : { section: "fixed:I", step: "S-8.2" }
    }
    case "addendum[].target_section":
      return { section: "fixed:5.4", step: "B-2.2" }
    case "flags[].section_id":
      return { section: "fixed:I", step: "S-9.5" }
    case "assumptions[].path": {
      const a = spine.assumptions.find((x) => x.id === owner)
      return { section: "fixed:5.4", step: a?.origin_step_id ?? "S-9.1" }
    }
    case "sections[].id":
      return { section: "fixed:I", step: "S-8.2" }
    default:
      // progress.screen_cursor, progress.screen_queue[], steps[].id
      return { section: "fixed:3.1.2", step: "S-5.1" }
  }
}

const deadReference = (spine: Spine): FlagCandidate[] =>
  findDeadReferences(spine).map((hit) => {
    const where = deadReferenceWhere(spine, hit)
    return {
      level: "red",
      rule_id: "dead_reference",
      section_id: where.section,
      target_id: hit.refPath,
      message: `${hit.refPath} trỏ tới "${hit.targetId}" không tồn tại`,
      remediation_step: where.step
    }
  })

// ─── red: diagram, nfr, S-9 ──────────────────────────────────────

const renderError = (spine: Spine): FlagCandidate[] =>
  spine.diagrams
    .filter((d) => d.render_status === "error")
    .map((d) => ({
      level: "red",
      rule_id: "render_error",
      section_id: d.section,
      target_id: d.id,
      message: `Hình ${d.id} (${d.kind}) render lỗi${d.error ? `: ${d.error}` : ""}`,
      remediation_step: renderStepOf(d)
    }))

const diagramStale = (spine: Spine): FlagCandidate[] =>
  spine.diagrams
    .filter((d) => d.render_status === "ok" && !UNHASHED_SOURCE_HASHES.has(d.source_hash))
    .filter((d) => d.source_hash !== computeSourceHash(spine, d))
    .map((d) => ({
      level: "red",
      rule_id: "diagram_stale",
      section_id: d.section,
      target_id: d.id,
      message: `Hình ${d.id} (${d.kind}) không còn khớp dữ liệu, cần render lại`,
      remediation_step: renderStepOf(d)
    }))

const nfrMissingNumber = (spine: Spine, gate: StepGate): FlagCandidate[] =>
  (["reliability", "performance"] as const).flatMap((category): FlagCandidate[] => {
    const { section, step } = NFR_SECTION[category]
    const items = spine.nfrs.filter((n) => n.category === category)
    if (items.length === 0) {
      // "Chưa có NFR nào" là luật "chưa có X" ⇒ qua cổng. Nhánh dưới soi NFR ĐÃ có mà thiếu số đo —
      // dữ liệu đã nằm đó thì thiếu số là lỗi thật, không phụ thuộc bước nào chốt chưa.
      return gate.done(step)
        ? [{ level: "red" as const, rule_id: "nfr_missing_number", section_id: section, target_id: null, message: `Chưa có NFR ${category} nào`, remediation_step: step }]
        : []
    }
    return items
      .filter((n) => !n.metric || !n.threshold)
      .map((n) => ({
        level: "red" as const,
        rule_id: "nfr_missing_number",
        section_id: section,
        target_id: n.id,
        message: `NFR ${n.id} (${category}) thiếu metric/threshold`,
        remediation_step: step
      }))
  })

const unconfirmedAssumption = (spine: Spine): FlagCandidate[] =>
  spine.assumptions
    .filter((a) => a.status === "unconfirmed")
    .map((a) => ({
      level: "red",
      rule_id: "unconfirmed_assumption",
      section_id: sectionsOfPath(spine, a.path).owner[0] ?? "fixed:5.4",
      target_id: a.id,
      message: `Giả định ${a.id} chưa được xác nhận: ${a.statement}`,
      remediation_step: a.origin_step_id || "S-9.1"
    }))

/**
 * BUG-14: user sửa hoặc bác bỏ một giả định, nhưng thứ ĐƯỢC SINH RA TỪ nó không đổi theo — lượt test có
 * AS28 sửa thành uptime 99% trong khi NFR N08 vẫn ghi ≥ 99.5%, và bản ký xuất ra mang số sai.
 *
 * Liên kết đã có sẵn: `assumptions[].path` trỏ đúng field mà giả định đang đỡ. Nếu giả định được sửa
 * (statement/status) SAU lần cuối field đó được ghi, thì field đang lạc hậu so với quyết định mới.
 */
const derivedFromChangedAssumption = (spine: Spine, changes: Pick<Change, "seq" | "path" | "before" | "value" | "step_id">[]): FlagCandidate[] => {
  const lastSeqByPrefix = (prefix: string): number => {
    let last = 0
    for (const c of changes) if (c.path === prefix || c.path.startsWith(`${prefix}.`) || c.path.startsWith(`${prefix}[`)) last = Math.max(last, c.seq)
    return last
  }

  return spine.assumptions.flatMap((assumption): FlagCandidate[] => {
    if (tryResolve(spine, assumption.path) === null) return []
    // Xác nhận một giả định là DUYỆT nội dung đang có, không phải đổi nó — chỉ "sửa statement" hoặc "bác
    // bỏ" mới làm field dẫn xuất lạc hậu. Tính cả lượt xác nhận thì bấm "Đúng hết" ở S-9.1 đẻ ra đúng
    // bằng ấy cờ vàng vô nghĩa.
    const rejectedAt = assumption.status === "rejected" ? lastSeqByPrefix(`assumptions[id=${assumption.id}].status`) : 0
    const decidedAt = Math.max(lastSeqByPrefix(`assumptions[id=${assumption.id}].statement`), rejectedAt)
    if (decidedAt === 0) return []
    const targetAt = lastSeqByPrefix(assumption.path)
    if (targetAt >= decidedAt) return []
    const verb = assumption.status === "rejected" ? "bị bác bỏ" : "được sửa"
    return [
      {
        level: "yellow",
        rule_id: "derived_from_changed_assumption",
        section_id: sectionsOfPath(spine, assumption.path).owner[0] ?? "fixed:5.4",
        target_id: assumption.id,
        message: `Giả định ${assumption.id} ${verb} ("${assumption.statement}") nhưng "${assumption.path}" chưa cập nhật theo`,
        remediation_step: ownerStepOf(sectionsOfPath(spine, assumption.path).owner[0] ?? "fixed:5.4", spine)
      }
    ]
  })
}

const sectionsAtBaseline = (spine: Spine, changes: Pick<Change, "seq" | "path" | "before" | "value" | "step_id">[]): FlagCandidate[] => {
  const states = computeSectionStates(spine, changes).filter((s) => s.required && !s.derived)
  return [
    ...states
      .filter((s) => s.status === "stale")
      .map((s) => ({
        level: "red" as const,
        rule_id: "section_stale_at_baseline",
        section_id: s.id,
        target_id: null,
        message: `Section ${s.id} đã cũ so với dữ liệu nó phụ thuộc`,
        remediation_step: ownerStepOf(s.id, spine)
      })),
    ...states
      .filter((s) => s.awaiting_reaccept)
      .map((s) => ({
        level: "red" as const,
        rule_id: "section_awaiting_reaccept",
        section_id: s.id,
        target_id: null,
        message: `Section ${s.id} đang chờ duyệt lại sau hoà giải`,
        remediation_step: ownerStepOf(s.id, spine)
      }))
  ]
}

/** Thứ tự phase để biết vòng S-5 đã đi qua chưa (không import step-registry: module này thuần trên Spine). */
const PHASE_ORDER = ["B-0", "B-1", "B-2", "S-1", "S-2", "S-3", "S-4", "S-5", "S-6", "S-7", "S-8", "S-9"] as const

const pastLoopPhase = (spine: Spine): boolean => {
  const index = PHASE_ORDER.indexOf((spine.progress.current_phase ?? "") as (typeof PHASE_ORDER)[number])
  return index > PHASE_ORDER.indexOf("S-5")
}

/**
 * BUG-03: màn bị để trống (`placeholder`) mà KHÔNG đi qua cổng S-5.1 của chính nó ⇒ không ai chủ động
 * quyết để lại màn đó. Trước đây màn như vậy lặng lẽ rơi khỏi hàng đợi: §3.2.1 chỉ còn tiêu đề, không cờ
 * nào bắt, và panel Tiến độ khoá luôn 5 step của nó. Cờ vàng (không chặn ký) kèm `remediation_step` mở lại
 * được vòng S-5 của màn.
 */
const screenPlaceholder = (spine: Spine, atBaseline: boolean): FlagCandidate[] => {
  if (!atBaseline && !pastLoopPhase(spine)) return []
  const decided = new Set(
    spine.steps.filter((st) => st.status === "accepted" && st.id.startsWith("S-5.1@")).map((st) => st.id.slice("S-5.1@".length))
  )
  return spine.screens
        .filter((s) => s.detail_status === "placeholder" && !decided.has(s.id))
        .map((s) => ({
          level: "yellow" as const,
          rule_id: "screen_placeholder",
          section_id: s.primary_function_id ? `function:${s.primary_function_id}` : "fixed:3.1.2",
          target_id: s.id,
          message: `Màn ${s.id} "${s.name}" bị để trống mà chưa qua cổng S-5.1 — mở lại để mô tả, hoặc chốt "để sau" kèm lý do`,
          remediation_step: `S-5.1@${s.id}`
        }))
}

/**
 * BUG-12: function NỀN (không thuộc màn nào, do S-4.4 sinh: nhắc lịch, nhả giữ chỗ, no-show, webhook) mà
 * không use case nào tham chiếu — thường là thiếu hẳn use case cho một cơ chế chạy theo lịch, nên §2.2
 * không hề nhắc tới nó. Function của màn không tính: chúng đã hiện trong mô tả màn.
 */
const functionWithoutUseCase = (spine: Spine, gate: StepGate): FlagCandidate[] => {
  if (!gate.done(GATE_STEP.function_without_uc)) return []
  const used = new Set(spine.use_cases.flatMap((u) => u.function_ids))
  return spine.functions
    .filter((f) => f.screen_id === null && !used.has(f.id))
    .map((f) => ({
      level: "yellow" as const,
      rule_id: "function_without_uc",
      section_id: `function:${f.id}`,
      target_id: f.id,
      message: `Chức năng nền "${f.name}" không thuộc use case nào — thiếu use case (vd cơ chế chạy theo lịch) hay thiếu liên kết?`,
      remediation_step: "S-3.2"
    }))
}

const screenPendingAtBaseline = (spine: Spine): FlagCandidate[] =>
  spine.screens
    .filter((s) => s.detail_status === "pending")
    .map((s) => ({
      level: "red",
      rule_id: "screen_pending_at_baseline",
      section_id: s.primary_function_id ? `function:${s.primary_function_id}` : "fixed:3.1.2",
      target_id: s.id,
      message: `Màn ${s.id} "${s.name}" chưa được mô tả chi tiết (S-5)`,
      remediation_step: `S-5.1@${s.id}`
    }))

// ─── yellow ──────────────────────────────────────────────────────

const cardinality = (spine: Spine, gate: StepGate): FlagCandidate[] => {
  const yellow = (rule_id: string, section_id: string, target_id: string, message: string, remediation_step: string): FlagCandidate => ({
    level: "yellow",
    rule_id,
    section_id,
    target_id,
    message,
    remediation_step
  })
  const usedActors = new Set(spine.use_cases.flatMap((u) => u.actor_ids))
  const fnScreens = new Set(spine.functions.map((f) => f.screen_id))

  // Mỗi luật qua cổng của bước SINH RA vế còn thiếu, không phải bước sửa: `usecase_no_function` sửa ở
  // S-3.2 nhưng chỉ có nghĩa sau S-4.4, lúc function đã được gắn vào use case.
  const when = (rule: keyof typeof GATE_STEP, make: () => FlagCandidate[]): FlagCandidate[] =>
    gate.done(GATE_STEP[rule]) ? make() : []

  return [
    // Mọi kind: actor system/time không tham gia use case nào cũng bị renderer bỏ khỏi sơ đồ
    // (chỉ actor có cạnh mới được khai báo) — biến mất im lặng nếu chỉ xét actor human.
    ...when("orphan_actor", () =>
      spine.actors
        .filter((a) => !usedActors.has(a.id))
        .map((a) => yellow("orphan_actor", "fixed:2.1", a.id, `Actor "${a.name}" không thuộc use case nào`, "S-3.2"))),
    ...when("usecase_no_function", () =>
      spine.use_cases
        .filter((u) => u.function_ids.length === 0)
        .map((u) => yellow("usecase_no_function", "fixed:2.2.2", u.id, `Use case "${u.name}" chưa gắn function nào`, "S-3.2"))),
    ...when("screen_no_function", () =>
      spine.screens
        .filter((s) => !fnScreens.has(s.id))
        .map((s) => yellow("screen_no_function", "fixed:3.1.2", s.id, `Màn "${s.name}" chưa có function nào`, "S-4.1"))),
    ...when("empty_feature", () =>
      spine.features
        .filter((f) => !spine.screens.some((s) => s.feature_id === f.id) && !spine.functions.some((fn) => fn.feature_id === f.id))
        .map((f) => yellow("empty_feature", `feature:${f.id}`, f.id, `Feature "${f.name}" không có màn lẫn function`, "S-4.1"))),
    ...when("role_no_actor", () =>
      spine.roles
        .filter((r) => r.actor_id === null)
        .map((r) => yellow("role_no_actor", "fixed:3.1.3", r.id, `Vai trò "${r.name}" chưa gắn actor`, "S-3.1")))
  ]
}

// ─── use case: quan hệ + đặt tên ─────────────────────────────

/** U3 — động từ quá thô: tên use case phải nói mục tiêu, không nói "trông coi". */
export const USE_CASE_VERB_BLACKLIST = [
  "Manage", "Handle", "Process", "Maintain", "Administer", "Support",
  "Control", "Operate", "Use", "Do", "Perform", "Work", "Deal", "Take"
] as const
/** U5 — thuật ngữ giao diện hay kỹ thuật không thuộc tên use case. */
export const UI_TERM_BLACKLIST = ["Button", "Screen", "Page", "Form", "Popup", "Tab", "Modal", "API", "Database"] as const
/** A2 — tên actor rỗng nghĩa. */
export const ACTOR_NAME_BLACKLIST = ["User", "System", "Actor", "Person"] as const
/** U1 — từ phụ không đứng đầu thì viết hoa hay thường đều hợp lệ. */
const MINOR_WORDS = [
  "a", "an", "the", "and", "or", "of", "to", "at", "for", "in", "on", "with", "by", "from", "as",
  "via", "into", "onto", "per", "vs"
]

const NAME_RULE_HINTS: Readonly<Record<string, string>> = Object.freeze({
  U1: "viết hoa đầu mỗi từ, không chấm cuối",
  U2: 'một mục tiêu duy nhất, không gộp bằng "and", "/" hay dấu phẩy',
  U3: "động từ quá thô, nói mục tiêu cụ thể",
  U4: "không nhắc tên actor trong tên use case",
  U5: "không dùng thuật ngữ giao diện hay kỹ thuật",
  U6: "tối đa 5 từ",
  U8: "trùng tên với use case khác",
  A2: "tên quá chung, không nhận ra vai trò",
  A7: "trùng tên với actor khác"
})

const hint = (codes: string[]): string => codes.map((c) => `${c} (${NAME_RULE_HINTS[c] ?? ""})`).join("; ")
const wordsOf = (name: string): string[] => name.trim().split(/\s+/).filter(Boolean)
const sameText = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase()
/** Khớp NGUYÊN TỪ, không phân biệt hoa thường: "Scheduler" không dính "Run Scheduled Housekeeping". */
const containsWord = (text: string, term: string): boolean =>
  new RegExp(`(?:^|[^A-Za-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[^A-Za-z0-9]|$)`, "i").test(text)

/**
 * Mã luật đặt tên use case bị vi phạm, tách làm hai nhóm vì mode 1 đối xử khác nhau:
 * `semantic` (U2, U3, U8) là lỗi mô hình hoá, đúng với mọi ngôn ngữ; `style` (U1, U4, U5, U6)
 * gắn chặt chính tả tiếng Anh nên vô nghĩa với một SRS tiếng Việt nhập vào.
 */
export const checkUseCaseName = (
  name: string,
  actorNames: readonly string[],
  allNames: readonly string[]
): { semantic: string[]; style: string[] } => {
  const parts = wordsOf(name)
  const semantic: string[] = []
  const style: string[] = []

  if (/ and |\/|,/i.test(name)) semantic.push("U2")
  // Bỏ ký tự không phải chữ cái quanh từ đầu: "Manage:" và "Manage-Projects" vẫn là "Manage"
  const leadVerb = /[A-Za-z]+/.exec(parts[0] ?? "")?.[0] ?? ""
  if (USE_CASE_VERB_BLACKLIST.some((v) => sameText(v, leadVerb))) semantic.push("U3")
  if (allNames.filter((n) => sameText(n, name)).length > 1) semantic.push("U8")

  // Sai hoa thường = từ KHÔNG có chữ hoa nào. Bắt đúng thứ U1 nhắm tới ("step", "gate") mà không
  // bắn vào "2FA", "(Optional)", "e-Sign" hay "iPhone" — cách viết cố ý, không phải lỗi.
  const wrongCase = parts.some((w, i) => !/[A-Z]/.test(w) && /[a-z]/.test(w) && !(i > 0 && MINOR_WORDS.includes(w.toLowerCase())))
  if (wrongCase || name.trim().endsWith(".")) style.push("U1")
  if (actorNames.some((a) => a.trim() !== "" && containsWord(name, a.trim()))) style.push("U4")
  if (UI_TERM_BLACKLIST.some((t) => containsWord(name, t))) style.push("U5")
  if (parts.length > 5) style.push("U6")

  return { semantic, style }
}

/** Mã luật đặt tên actor bị vi phạm: A2 (tên rỗng nghĩa), A7 (trùng tên). */
export const checkActorName = (name: string, allNames: readonly string[]): string[] => {
  const codes: string[] = []
  if (ACTOR_NAME_BLACKLIST.some((b) => sameText(b, name))) codes.push("A2")
  if (allNames.filter((n) => sameText(n, name)).length > 1) codes.push("A7")
  return codes
}

/**
 * MỌI id nằm trên một vòng của đồ thị khoá = mọi node thuộc một thành phần liên thông mạnh ≥ 2 node
 * (Tarjan; tự tham chiếu đã bị loại khỏi đồ thị và báo riêng). Không dựa vào đường duyệt DFS: vòng
 * khép qua một node đã duyệt xong (UC01→UC05→UC02→UC01 khi UC02 được thăm trước) vẫn phải cờ đủ.
 * Thứ tự ra ổn định.
 */
const cycleNodes = (edges: ReadonlyMap<string, readonly string[]>): string[] => {
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const found: string[] = []
  let counter = 0
  const connect = (id: string): void => {
    index.set(id, counter)
    low.set(id, counter)
    counter += 1
    stack.push(id)
    onStack.add(id)
    for (const next of edges.get(id) ?? []) {
      if (!index.has(next)) {
        connect(next)
        low.set(id, Math.min(low.get(id)!, low.get(next)!))
      } else if (onStack.has(next)) {
        low.set(id, Math.min(low.get(id)!, index.get(next)!))
      }
    }
    if (low.get(id) !== index.get(id)) return
    const component: string[] = []
    for (let top = stack.pop(); top !== undefined; top = top === id ? undefined : stack.pop()) {
      onStack.delete(top)
      component.push(top)
    }
    if (component.length > 1) found.push(...component)
  }
  for (const id of [...edges.keys()].sort()) if (!index.has(id)) connect(id)
  return found.sort()
}

const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`)

const useCaseRelations = (spine: Spine): FlagCandidate[] => {
  const known = new Set(spine.use_cases.map((u) => u.id))
  // Tự tham chiếu được báo riêng nên loại khỏi đồ thị; id chết là việc của "dead_reference".
  const graphOf = (pick: (u: Spine["use_cases"][number]) => readonly string[]): Map<string, string[]> =>
    new Map(spine.use_cases.map((u) => [u.id, [...pick(u)].filter((t) => known.has(t) && t !== u.id)]))
  const includes = graphOf((u) => u.includes)
  const extendsTo = graphOf((u) => u.extends)
  // Hai đồ thị xét RIÊNG: gộp lại sẽ báo nhầm "A includes B + B extends A" là vòng, trong khi
  // đó là lỗi "cùng một cặp mang hai quan hệ" và cần thông điệp khác.
  const cyclic = new Set([...cycleNodes(includes), ...cycleNodes(extendsTo)])
  const pairsOf = (graph: ReadonlyMap<string, readonly string[]>): Set<string> =>
    new Set([...graph].flatMap(([a, targets]) => targets.map((b) => pairKey(a, b))))
  const extendPairs = pairsOf(extendsTo)
  const bothRelations = new Set([...pairsOf(includes)].filter((k) => extendPairs.has(k)))

  return spine.use_cases.flatMap((u): FlagCandidate[] => {
    const problems: string[] = []
    if (u.includes.includes(u.id) || u.extends.includes(u.id)) problems.push("tự tham chiếu chính nó")
    if (cyclic.has(u.id)) problems.push("nằm trong một vòng include/extend")
    const both = [...new Set([...(includes.get(u.id) ?? []), ...(extendsTo.get(u.id) ?? [])])]
      .filter((v) => bothRelations.has(pairKey(u.id, v)))
      .sort()
    if (both.length > 0) problems.push(`vừa include vừa extend với ${both.join(", ")}`)
    if (problems.length === 0) return []
    return [{
      level: "red",
      rule_id: "usecase_relation_invalid",
      section_id: "fixed:2.2.2",
      target_id: u.id,
      message: `Quan hệ của use case "${u.name}" không hợp lệ: ${problems.join("; ")}`,
      remediation_step: "S-3.4"
    }]
  })
}

/** Use case không actor, không extend, không bị include ⇒ đứng lơ lửng trên hình. */
const useCaseFloating = (spine: Spine, gate: StepGate): FlagCandidate[] => {
  if (!gate.done(GATE_STEP.usecase_floating)) return []
  const included = new Set(spine.use_cases.flatMap((u) => u.includes))
  return spine.use_cases
    .filter((u) => u.actor_ids.length === 0 && u.extends.length === 0 && !included.has(u.id))
    .map((u) => ({
      level: "yellow" as const,
      rule_id: "usecase_floating",
      section_id: "fixed:2.2.2",
      target_id: u.id,
      message: `Use case "${u.name}" không có actor và không nối use case nào`,
      remediation_step: "S-3.2"
    }))
}

/**
 * Cụm tên của use case xác thực / truy cập tài khoản. Tên (đã chuẩn hoá: NFC, chữ thường, dấu câu thành
 * khoảng trắng) phải BẮT ĐẦU bằng một cụm, và phần còn lại chỉ được là bổ ngữ cách thức ("with Google",
 * "to Portal", "bằng Google") — nên "View Login History", "Sign Up for Newsletter", "Registered Book Loan"
 * không bị nhận nhầm. Có tiếng Việt vì mode 1 nhập SRS tiếng Việt và luật này vẫn chạy ở đó.
 */
export const ACCOUNT_ACCESS_PHRASES = [
  "log in", "login", "log on", "sign in", "signin", "sign up", "signup", "authenticate",
  "register account", "register an account", "create account", "create an account",
  "reset password", "reset forgotten password", "forgot password", "recover password",
  "recover account", "recover an account",
  "đăng nhập", "đăng ký tài khoản", "quên mật khẩu", "đặt lại mật khẩu", "khôi phục mật khẩu", "khôi phục tài khoản"
] as const
/** Tên chỉ gồm đúng một từ này cũng là use case truy cập tài khoản ("Register", "Đăng ký"). */
const ACCOUNT_ACCESS_EXACT = ["register", "đăng ký"] as const

/** Từ mở đầu bổ ngữ cách thức được phép đứng sau cụm truy cập tài khoản. */
const ACCOUNT_ACCESS_MANNER = ["with", "to", "via", "using", "into", "through", "bằng", "vào", "qua"] as const

// NFC trước: tài liệu nhập ở mode 1 có thể mang tiếng Việt dạng tổ hợp (NFD), "đăng nhập" sẽ không khớp
const normalizeName = (name: string): string => name.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()

export const isAccountAccessUseCase = (name: string): boolean => {
  const norm = normalizeName(name)
  if (ACCOUNT_ACCESS_EXACT.some((w) => norm === w)) return true
  return ACCOUNT_ACCESS_PHRASES.some((p) => {
    if (norm === p) return true
    if (!norm.startsWith(`${p} `)) return false
    const nextWord = norm.slice(p.length + 1).split(" ")[0] ?? ""
    return (ACCOUNT_ACCESS_MANNER as readonly string[]).includes(nextWord)
  })
}

/**
 * Use case xác thực / truy cập tài khoản bị mô hình hoá thành luồng con: bị use case khác include,
 * hoặc chính nó extend một use case khác. Đăng nhập là TIỀN ĐIỀU KIỆN của use case được bảo vệ (một
 * trạng thái), không phải bước chạy lại mỗi lần; Register / Reset Password là mục tiêu riêng actor chủ
 * động mở ra làm. Quan hệ sai kiểu này làm renderer bỏ cạnh actor ⇒ use case trông như chương trình con.
 * Log In làm BASE của một extend (vd. xác thực 2 lớp khi thiết bị lạ) là hợp lệ nên không bắt.
 */
const useCaseAccountAccessRelation = (spine: Spine): FlagCandidate[] => {
  const includers = new Map<string, string[]>()
  for (const u of spine.use_cases) for (const t of u.includes) includers.set(t, [...(includers.get(t) ?? []), u.name])
  const nameOf = new Map(spine.use_cases.map((u) => [u.id, u.name]))

  return spine.use_cases
    .filter((u) => isAccountAccessUseCase(u.name))
    .flatMap((u): FlagCandidate[] => {
      const problems: string[] = []
      const by = includers.get(u.id) ?? []
      if (by.length > 0) problems.push(`bị include bởi ${by.join(", ")}`)
      if (u.extends.length > 0) problems.push(`extend ${u.extends.map((id) => nameOf.get(id) ?? id).join(", ")}`)
      if (problems.length === 0) return []
      return [{
        level: "yellow",
        rule_id: "usecase_auth_relation",
        section_id: "fixed:2.2.2",
        target_id: u.id,
        message:
          `Use case xác thực/truy cập tài khoản "${u.name}" đang là luồng con (${problems.join("; ")}). ` +
          "Nên để đứng riêng; yêu cầu đã đăng nhập ghi thành tiền điều kiện trong mô tả use case",
        remediation_step: "S-3.4"
      }]
    })
}

const namingShape = (spine: Spine): FlagCandidate[] => {
  const actorNames = spine.actors.map((a) => a.name)
  const useCaseNames = spine.use_cases.map((u) => u.name)
  const out: FlagCandidate[] = []

  for (const u of spine.use_cases) {
    const { semantic, style } = checkUseCaseName(u.name, actorNames, useCaseNames)
    for (const [rule_id, codes] of [["usecase_name_semantic", semantic], ["usecase_name_style", style]] as const) {
      if (codes.length === 0) continue
      out.push({
        level: "yellow",
        rule_id,
        section_id: "fixed:2.2.2",
        target_id: u.id,
        message: `Tên use case "${u.name}" chưa đạt: ${hint(codes)}`,
        remediation_step: "S-3.2"
      })
    }
  }
  for (const a of spine.actors) {
    const codes = checkActorName(a.name, actorNames)
    if (codes.length === 0) continue
    out.push({
      level: "yellow",
      rule_id: "actor_name_shape",
      section_id: "fixed:2.1",
      target_id: a.id,
      message: `Tên actor "${a.name}" chưa đạt: ${hint(codes)}`,
      remediation_step: "S-3.1"
    })
  }
  return out
}

// ─── tên hệ thống (FLF-177) ─────────────────────────────────

/**
 * Sơ đồ ngữ cảnh (S-2.5) hay use case đã vẽ mà chưa có `project.system_name` ⇒ boundary đang in tên project làm
 * việc. Chủ sở hữu field là B-0.1; user sửa qua chat (`set project.system_name`).
 */
const systemNameMissing = (spine: Spine): FlagCandidate[] =>
  !spine.project.system_name?.trim() && (hasKind(spine, "context") || hasKind(spine, "usecase"))
    ? [
        {
          level: "yellow",
          rule_id: "system_name_missing",
          section_id: "fixed:1",
          target_id: null,
          message: `Chưa chốt tên hệ thống (tiếng Anh) — sơ đồ và bìa tài liệu đang dùng tên dự án "${spine.project.name}"`,
          remediation_step: "B-0.1"
        }
      ]
    : []

/** Dấu tiếng Việt (yellow-rules.md). */
export const VIETNAMESE_DIACRITICS = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i

const textsOf = (value: unknown): string[] => {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap(textsOf)
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(textsOf)
  return []
}

interface ScanItem {
  path: string
  target_id: string | null
  section: string
  step: string
  fields: Record<string, unknown>
}

/** Field thuộc cột Sở hữu (render vào SRS). Bỏ `addendum`, `glossary[].term_native`, reason, message — theo ngôn ngữ user. */
const ownedTexts = (spine: Spine): ScanItem[] => {
  const p = spine.project
  return [
    // BUG-11: `project.name` là tên user đặt cho dự án (tiếng Việt là bình thường). Nó chỉ lọt vào tài liệu
    // khi CHƯA có `system_name`; đã chốt tên hệ thống tiếng Anh rồi thì đừng bắt user đổi tên dự án nữa.
    {
      path: "project",
      target_id: null,
      section: "fixed:1",
      step: p.system_name?.trim() ? "B-0.1" : "S-2.1",
      fields: {
        ...(p.system_name?.trim() ? {} : { name: p.name }),
        system_name: p.system_name,
        vision: p.vision,
        goals: p.goals,
        release_scope: p.release_scope
      }
    },
    ...spine.actors.map((a) => ({
      path: `actors[id=${a.id}]`,
      target_id: a.id,
      section: a.kind === "human" ? "fixed:2.1" : "fixed:1",
      step: a.kind === "human" ? "S-3.1" : "S-2.3",
      fields: { name: a.name, description: a.description }
    })),
    ...spine.roles.map((r) => ({ path: `roles[id=${r.id}]`, target_id: r.id, section: "fixed:3.1.3", step: "S-3.1", fields: { name: r.name } })),
    ...spine.use_cases.map((u) => ({ path: `use_cases[id=${u.id}]`, target_id: u.id, section: "fixed:2.2.2", step: "S-3.5", fields: { name: u.name, description: u.description } })),
    ...spine.features.map((f) => ({ path: `features[id=${f.id}]`, target_id: f.id, section: `feature:${f.id}`, step: "S-4.1", fields: { name: f.name } })),
    ...spine.screens.map((s) => ({ path: `screens[id=${s.id}]`, target_id: s.id, section: "fixed:3.1.2", step: "S-4.1", fields: { name: s.name, description: s.description, tabs: s.tabs } })),
    ...spine.functions.map((f) => ({
      path: `functions[id=${f.id}]`,
      target_id: f.id,
      section: `function:${f.id}`,
      step: functionStep(spine, f.id, "S-5.2"),
      fields: { name: f.name, trigger: f.trigger, description: f.description, normal: f.normal, abnormal: f.abnormal, validations: f.validations.map((v) => v.statement) }
    })),
    ...spine.entities.map((e) => ({ path: `entities[id=${e.id}]`, target_id: e.id, section: "fixed:3.1.5", step: "S-4.5", fields: { name: e.name, description: e.description } })),
    ...spine.nfrs.map((n) => ({
      path: `nfrs[id=${n.id}]`,
      target_id: n.id,
      section: NFR_SECTION[n.category].section,
      step: NFR_SECTION[n.category].step,
      fields: { statement: n.statement, metric: n.metric, threshold: n.threshold }
    })),
    ...spine.business_rules.map((b) => ({
      path: `business_rules[id=${b.id}]`,
      target_id: b.id,
      section: b.tier === "high" ? "fixed:1" : "fixed:5.1",
      step: b.tier === "high" ? "S-2.4" : "S-7.1",
      fields: { statement: b.statement }
    })),
    ...spine.common_requirements.map((c) => ({ path: `common_requirements[id=${c.id}]`, target_id: c.id, section: "fixed:5.2", step: "S-7.2", fields: { category: c.category, statement: c.statement } })),
    ...spine.messages.map((m) => ({ path: `messages[id=${m.id}]`, target_id: m.id, section: "fixed:5.3", step: "S-7.3", fields: { text: m.text } })),
    ...spine.other_requirements.map((o) => ({ path: `other_requirements[id=${o.id}]`, target_id: o.id, section: "fixed:5.4", step: "S-7.4", fields: { statement: o.statement } })),
    ...spine.glossary.map((g) => ({ path: `glossary[id=${g.id}]`, target_id: g.id, section: "fixed:5.5", step: "S-8.1", fields: { term: g.term, definition: g.definition } })),
    ...spine.diagrams.map((d) => ({ path: `diagrams[id=${d.id}]`, target_id: d.id, section: d.section, step: renderStepOf(d), fields: { puml: d.puml } }))
  ]
}

const nonEnglishContent = (spine: Spine): FlagCandidate[] =>
  ownedTexts(spine).flatMap((item) => {
    const offending = Object.entries(item.fields)
      .filter(([, v]) => textsOf(v).some((t) => VIETNAMESE_DIACRITICS.test(t)))
      .map(([k]) => `${item.path}.${k}`)
    if (offending.length === 0) return []
    return [
      {
        level: "yellow" as const,
        rule_id: "non_english_content",
        section_id: item.section,
        target_id: item.target_id,
        message: `Nội dung render vào SRS phải bằng tiếng Anh: ${offending.join(", ")}`,
        remediation_step: item.step
      }
    ]
  })

// ─── entry ───────────────────────────────────────────────────────

/**
 * Chạy toàn bộ luật. `changes` cần cho `section_stale_at_baseline` (status là hàm tính).
 * Kết quả đã khử trùng theo `flagKey`; `section_id` luôn phân giải được.
 */
export const runDeterministicCheck = (
  spine: Spine,
  changes: Pick<Change, "seq" | "path" | "before" | "value" | "step_id">[] = [],
  options: CheckOptions = {}
): FlagCandidate[] => {
  const atBaseline = options.atBaseline ?? false
  const gate = stepGate(spine, atBaseline || (options.ruleProfile?.skipOwnerStepGate ?? false))
  const candidates: FlagCandidate[] = applyRuleProfile([
    ...sectionEmpty(spine, gate),
    ...arrayEmpty(spine, gate),
    ...deadReference(spine),
    ...renderError(spine),
    ...diagramStale(spine),
    ...nfrMissingNumber(spine, gate),
    ...useCaseRelations(spine),
    ...(atBaseline ? [...unconfirmedAssumption(spine), ...sectionsAtBaseline(spine, changes), ...screenPendingAtBaseline(spine)] : []),
    ...screenPlaceholder(spine, atBaseline),
    ...derivedFromChangedAssumption(spine, changes),
    ...functionWithoutUseCase(spine, gate),
    ...cardinality(spine, gate),
    ...useCaseFloating(spine, gate),
    ...useCaseAccountAccessRelation(spine),
    ...namingShape(spine),
    ...systemNameMissing(spine),
    ...nonEnglishContent(spine)
  ], options.ruleProfile)

  const index = buildIdIndex(spine)
  const seen = new Set<string>()
  const out: FlagCandidate[] = []
  for (const c of candidates) {
    const safe = sectionKeyExists(index, c.section_id) ? c : { ...c, section_id: "fixed:I" }
    const key = flagKey(safe)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(safe)
  }
  return out
}
