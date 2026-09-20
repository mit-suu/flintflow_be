/**
 * spine.types.ts
 * ─────────────────────────────────────────────────────────────────
 * Kiểu dữ liệu Spine — chép từ context/srs-spine.md §2.
 *
 * Tên field giữ snake_case y như tài liệu để path selector (T08) khớp 1-1
 * với tài liệu: `actors[id=A03].name`, `permissions[screen_id=S3,...]`.
 *
 * Quy ước:
 * - Thời điểm là chuỗi ISO 8601 (dạng wire/JSON). Mongo lưu Date; repository
 *   chuyển về chuỗi khi đọc.
 * - `?` trong tài liệu ⇒ optional. `| null` trong tài liệu ⇒ nullable.
 * - Giá trị chưa có trước khi step ghi (vision, accepted_at…) ⇒ nullable.
 * - Không có trường suy diễn: `sections[].status` và % tiến độ là hàm tính (T09).
 *
 * Mọi thay đổi ở đây phải đồng bộ `spine.schema.ts` — file đó có kiểm tra
 * compile-time bắt hai bên lệch nhau.
 */

/** Chuỗi ISO 8601, ví dụ "2026-09-14T08:00:00.000Z". */
export type IsoDateTime = string

// ─── project / progress / steps ──────────────────────────────────

export type WorkingMode = "fast" | "coaching"

export interface ReleaseScope {
  in: string[]
  out: string[]
}

export interface SpineProject {
  name: string
  vision: string | null
  goals: string[]
  type: string | null
  domain: string | null
  complexity: string | null
  form_factor: string | null
  stakes: string | null
  working_mode: WorkingMode | null
  release_scope: ReleaseScope
}

export interface Progress {
  current_phase: string | null
  current_step: string | null
  screen_cursor: string | null
  screen_queue: string[]
  elicit_turns_this_phase: number
}

export type StepStatus = "pending" | "in_progress" | "accepted" | "revision_requested"

export interface StepState {
  /** Step id theo registry, có thể kèm `@<screen_id>` cho vòng S-5. */
  id: string
  status: StepStatus
  first_seq: number | null
  last_seq: number | null
  accepted_at: IsoDateTime | null
}

// ─── thực thể nghiệp vụ ──────────────────────────────────────────

export interface Feature {
  id: string
  name: string
  order: number
}

export type ActorKind = "human" | "system" | "time"

export interface Actor {
  id: string
  name: string
  kind: ActorKind
  description: string
  /** Nhãn luồng dữ liệu actor gửi VÀO hệ thống, vẽ lên cạnh §1 context diagram (tiếng Anh). */
  flows_in?: string[]
  /** Nhãn luồng dữ liệu hệ thống gửi RA actor (tiếng Anh). */
  flows_out?: string[]
}

export interface Role {
  id: string
  name: string
  actor_id: string | null
}

export interface UseCase {
  id: string
  name: string
  actor_ids: string[]
  function_ids: string[]
  description: string
  includes: string[]
  extends: string[]
}

export type ScreenDetailStatus = "pending" | "in_progress" | "signed_off" | "placeholder"

export interface Screen {
  id: string
  feature_id: string
  name: string
  description: string
  flow_to: string[]
  is_popup: boolean
  tabs: string[]
  primary_function_id: string | null
  queue_order: number | null
  detail_status: ScreenDetailStatus
}

export interface Permission {
  id: string
  screen_id: string
  role_id: string
  action: string
}

export interface Entity {
  id: string
  name: string
  description: string
  /** Khoá tới `entities[].id` (reference_fields §4.1). */
  relations: string[]
}

/** MoSCoW, gán ở S-9.4. `null` trước khi gán. */
export type Priority = "must" | "should" | "could" | "wont"

export type ValidationKind = "business" | "format" | "required"

export interface Validation {
  id: string
  kind: ValidationKind
  statement: string
}

/**
 * Tên `Function` theo tài liệu. Khi import ở module khác nên dùng alias
 * `SpineFunction` để không che kiểu global `Function`.
 */
export interface Function {
  id: string
  screen_id: string | null
  feature_id: string
  order: number
  name: string
  trigger: string
  description: string
  normal: string[]
  abnormal: string[]
  validations: Validation[]
  business_rule_ids: string[]
  priority: Priority | null
}
export type SpineFunction = Function

export type NfrCategory = "interface" | "usability" | "reliability" | "performance" | "other"
export type NfrKind = "quantitative" | "descriptive"

export interface Nfr {
  id: string
  category: NfrCategory
  statement: string
  kind: NfrKind
  metric?: string
  threshold?: string
  priority: Priority | null
}

export type BusinessRuleTier = "high" | "detail"

export interface BusinessRule {
  id: string
  tier: BusinessRuleTier
  statement: string
  source_validation_ids: string[]
}

export interface CommonRequirement {
  id: string
  category: string
  statement: string
}

export interface Message {
  id: string
  code: string
  text: string
  function_ids: string[]
}

export type OtherRequirementKind = "risk" | "assumption" | "open_question" | "technical_risk"

export interface OtherRequirement {
  id: string
  kind: OtherRequirementKind
  statement: string
}

export interface GlossaryTerm {
  id: string
  term: string
  term_native?: string
  definition: string
}

export interface Addendum {
  id: string
  topic: string
  content: string
  content_en: string
  /** Section id đích, ví dụ `fixed:5.4`. */
  target_section: string
  captured_at: IsoDateTime
}

// ─── state nội bộ ────────────────────────────────────────────────

export type DiagramKind = "context" | "usecase" | "screen_flow" | "erd" | "screen_layout"
export type RenderStatus = "ok" | "error"

export interface Diagram {
  id: string
  kind: DiagramKind
  puml: string
  section: string
  owner_kind: string | null
  owner_id: string | null
  render_status: RenderStatus
  error?: string
  source_hash: string
  rendered_at: IsoDateTime | null
}

export type AssumptionStatus = "unconfirmed" | "confirmed" | "rejected"

export interface Assumption {
  id: string
  /** Path selector tới field mang giả định. */
  path: string
  statement: string
  rationale: string
  origin_step_id: string
  status: AssumptionStatus
  confirmed_at: IsoDateTime | null
}

export type FlagLevel = "red" | "yellow"

export interface Flag {
  id: string
  level: FlagLevel
  rule_id: string
  section_id: string
  /** Tài liệu ghi `target_id?` và "nullable" — chấp nhận cả hai. */
  target_id?: string | null
  message: string
  remediation_step: string
  opened_at_version: number
  resolved_at: IsoDateTime | null
  waived_by_user: boolean
  /** Bắt buộc ≥ 20 ký tự khi waive (srs-spine.md §7). */
  waive_reason: string | null
  waived_at_version: number | null
}

/** `status` KHÔNG lưu — là hàm tính (srs-spine.md §5, T09). */
export interface SectionState {
  id: string
  asset_version: string
}

export interface Baseline {
  id: string
  /** `v1.0` hoặc `v1.0-conditional` khi `waived_count > 0`. */
  version: string
  at: IsoDateTime
  /** `_id` của document trong collection `baselines` (snapshot). */
  snapshot_ref: string
  checked_at_version: number
  waived_count: number
}

// ─── Spine document ──────────────────────────────────────────────

/**
 * Nội dung lưu trong collection `spines` (một document mỗi project).
 *
 * Nằm NGOÀI document này (giới hạn 16MB của Mongo):
 * - `changes[]`  → collection `changes`   (xem `Change`)
 * - `usage[]`    → collection `usages`    (xem `Usage`)
 * - snapshot của `baselines[]` → collection `baselines` (xem `BaselineSnapshot`)
 * - `sessions[]` → collection `chatsessions`, cờ `is_pipeline`
 */
export interface Spine {
  project: SpineProject
  progress: Progress
  steps: StepState[]

  features: Feature[]
  actors: Actor[]
  roles: Role[]
  use_cases: UseCase[]
  screens: Screen[]
  permissions: Permission[]
  entities: Entity[]
  functions: Function[]
  nfrs: Nfr[]
  business_rules: BusinessRule[]
  common_requirements: CommonRequirement[]
  messages: Message[]
  other_requirements: OtherRequirement[]
  glossary: GlossaryTerm[]
  addendum: Addendum[]

  diagrams: Diagram[]
  assumptions: Assumption[]
  flags: Flag[]
  sections: SectionState[]
  baselines: Baseline[]

  /** Tăng đơn điệu, đúng một lần mỗi transaction. Bắt đầu từ 1. */
  spine_version: number
}

/** Spine kèm khoá project — dạng repository trả về và GET /spine trả ra. */
export interface SpineRecord extends Spine {
  projectId: string
}

// ─── collection tách riêng ───────────────────────────────────────

/** Một op đã áp, collection `changes`. Khoá `(projectId, seq)` duy nhất. */
export interface Change {
  projectId: string
  seq: number
  txn: string
  op: string
  path: string
  /** Giá trị trước op (null nếu `add`). Dùng cho undo/resume. */
  before: unknown
  value: unknown
  reason: string | null
  at: IsoDateTime
  /** userId, hoặc tác nhân hệ thống (ví dụ "system"). */
  by: string
  step_id: string | null
}

export type UsageState = "reserved" | "deducted" | "refunded"

/** Một lượt gọi model, collection `usages`. */
export interface Usage {
  projectId: string
  userId: string
  step_id: string
  call_kind: string
  attempt: number
  tokens_in: number
  tokens_out: number
  cost: number
  state: UsageState
  expires_at: IsoDateTime
  /** `_id` của AiActionLog tương ứng, nếu có. */
  logId: string | null
}

/** Snapshot Spine tại thời điểm baseline, collection `baselines`. */
export interface BaselineSnapshot {
  projectId: string
  version: string
  at: IsoDateTime
  checked_at_version: number
  waived_count: number
  snapshot: Spine
}
