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

/**
 * Mức duyệt (02-reduce-stops-plan R5; FLF-337 business-flow §1.2): `strict` mọi bước · `fast` cuối giai đoạn · `milestones`
 * chỉ ở mốc chốt (cổng cứng — `quiet-step.ts` `HARD_GATE_STEPS`). `balanced` là giá trị cũ, đọc như `fast` (FLF-220).
 * Không bao giờ do độ tự tin của AI quyết định.
 */
export type ReviewMode = "strict" | "balanced" | "fast" | "milestones"

export interface ReleaseScope {
  in: string[]
  out: string[]
}

export interface SpineProject {
  name: string
  /**
   * FLF-177 — tên hệ thống (tiếng Anh) in trên sơ đồ và tài liệu, tách khỏi tên project làm việc.
   * `null` ⇒ dùng tên project (Spine trước FLF-177 không có field này).
   */
  system_name: string | null
  vision: string | null
  goals: string[]
  type: string | null
  domain: string | null
  complexity: string | null
  /** Các nền tảng, phần tử đầu là chính; `[]` = chưa chốt (FLF-237). */
  form_factor: string[]
  stakes: string | null
  working_mode: WorkingMode | null
  /** Cách duyệt (R5, FLF-337): `strict` | `balanced` | `fast` | `milestones`. */
  review_mode: ReviewMode
  /**
   * FLF-337 "Chấp nhận, không hỏi lại phần này": section id (`fixed:5`, `custom:…`). Bước / bản sửa chỉ chạm các section này
   * tự qua ở mọi mức duyệt (vẫn dừng khi có cờ đỏ mới, xoá nội dung). Bật lại trong cài đặt dự án. Spine cũ ⇒ `[]`.
   */
  skip_confirm_sections: string[]
  release_scope: ReleaseScope
}

export interface Progress {
  current_phase: string | null
  current_step: string | null
  screen_cursor: string | null
  screen_queue: string[]
  elicit_turns_this_phase: number
}

/** `skipped` (FLF-182): step không áp dụng cho template của project mode 1 — bị ẩn, không tính tiến độ. */
export type StepStatus = "pending" | "in_progress" | "accepted" | "revision_requested" | "skipped"

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
  /**
   * Actor tổng quát mà actor này là một dạng chuyên biệt (UML generalization `Customer --|> User`).
   * Chỉ actor người ↔ actor người. Use case dùng chung đặt ở actor cha; actor con thừa kế.
   */
  parent_id?: string | null
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

/** Cạnh Screens Flow: `to` = màn đích; `trigger` = hành động người dùng làm; `guard` = điều kiện rẽ nhánh (khác nhau giữa các cạnh cùng màn nguồn). */
export interface FlowEdge {
  to: string
  trigger?: string
  guard?: string
}

export interface Screen {
  id: string
  feature_id: string
  name: string
  description: string
  flow_to: FlowEdge[]
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

/** `key` = định danh (`{id}`), `reference` = tham chiếu tới entity khác (`{ref}`), `plain` = còn lại. Mức domain: không có kiểu dữ liệu. */
export type EntityAttributeKind = "key" | "reference" | "plain"

export interface EntityAttribute {
  /** Khoá của phần tử trong `attributes[]` (path `attributes[name=…]`), duy nhất trong một entity. */
  name: string
  kind: EntityAttributeKind
  /** Bắt buộc có giá trị; `false` ⇒ bản số `[0..1]` trên hình. */
  required: boolean
  description?: string
}

/** Một trạng thái trong vòng đời của entity. `id` duy nhất trên toàn Spine (như `validations`), `name` là tính từ / phân từ (Pending, Approved). */
export interface EntityState {
  id: string
  name: string
  /** Trạng thái đầu tiên của vòng đời — đúng một khi entity có trạng thái; hình có chấm đặc nối vào. */
  initial?: boolean
  /** Trạng thái kết thúc — hình có vòng tròn đồng tâm (bullseye) nối ra; không có transition đi ra. */
  final?: boolean
}

/** Chuyển trạng thái `event [guard] / action`. Khoá phần tử = `from` + `to` + `event` (path `transitions[from=…,to=…,event=…]`). */
export interface EntityTransition {
  /** Id `states[]` của cùng entity. */
  from: string
  /** Id `states[]` của cùng entity; `to = from` ⇒ chuyển nội bộ (hiện trong state). */
  to: string
  /** Sự kiện kích hoạt; không chứa `,` `[` `]` (khoá selector). */
  event: string
  guard?: string
  action?: string
  /** Business rule quy định chuyển trạng thái này. */
  business_rule_ids?: string[]
}

export interface Entity {
  id: string
  name: string
  description: string
  /** Khoá tới `entities[].id` (reference_fields §4.1). */
  relations: string[]
  /** Động từ của từng quan hệ, khoá là id trong `relations` (vd `{ E02: "contains" }`). Thiếu ⇒ `has`. */
  relation_verbs?: Record<string, string>
  /** Bản số phía con của từng quan hệ (`"1"` = một–một). Thiếu ⇒ `"N"`. */
  relation_cardinality?: Record<string, "1" | "N">
  /** Id con có liên kết TUỲ CHỌN tới cha này (con tồn tại được khi không có nó). */
  relation_optional?: string[]
  /** Dữ liệu chủ tồn tại độc lập — được phép không có cha. */
  root?: boolean
  /** Thuộc tính mức domain (không kiểu kỹ thuật). Thiếu ⇒ `[]`. */
  attributes?: EntityAttribute[]
  /** Feature dùng entity này — mỗi feature một class diagram. Khoá tới `features[].id`. Thiếu ⇒ `[]`. */
  feature_ids?: string[]
  /** Vòng đời của entity (state machine diagram). Entity không có vòng đời ⇒ `[]` và không có hình. Thiếu ⇒ `[]`. */
  states?: EntityState[]
  transitions?: EntityTransition[]
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
  /** Câu bằng ngôn ngữ user (FLF-237); dữ liệu cũ không có. */
  statement_vi?: string | null
}

export interface GlossaryTerm {
  id: string
  term: string
  term_native?: string
  definition: string
}

/** Khối nội dung nguyên văn của một mục riêng (FLF-182). Chỉ field hợp với `kind` mang giá trị, còn lại `null`. */
export interface CustomBlock {
  kind: "paragraph" | "list_item" | "table" | "image"
  text: string
  /** Chỉ với `table`: text từng ô theo hàng. */
  rows: string[][] | null
  /** Chỉ với `image`: tham chiếu file ảnh đã lưu. */
  image_ref: string | null
  /**
   * Chỉ với `image` là **sơ đồ gốc của người dùng** mà I-4 đọc được (mode 1 v3 §4.13): hình giữ nguyên trong tài liệu,
   * PlantUML cùng loại không in ra. `source_hash` = hash dữ liệu hình thể hiện lúc import (`computeSourceHash`) —
   * lệch ⇒ cờ vàng `original_diagram_stale`, CR chạm dữ liệu đó thì đề xuất vẽ lại (bỏ ảnh gốc). Không có ⇒ ảnh thường.
   */
  diagram?: OriginalDiagram | null
}

/** Loại sơ đồ gốc đọc được từ ảnh (I-4) — một hình mỗi loại trong tài liệu. */
export type OriginalDiagramKind = "context" | "usecase" | "screen_flow" | "erd"

export interface OriginalDiagram {
  kind: OriginalDiagramKind
  source_hash: string
}

/**
 * Mục riêng của template người dùng (mode 1 v2, FLF-182): heading không khớp section FPT nào, hoặc phần văn xuôi
 * không trích được vào field — giữ nguyên văn để render lại đúng vị trí (section `custom:<id>`) và sửa qua chat.
 */
export interface CustomSection {
  id: string
  heading: string
  level: number
  blocks: CustomBlock[]
  source: "import" | "manual"
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

export type DiagramKind = "context" | "usecase" | "screen_flow" | "erd" | "class" | "state_machine" | "screen_layout"
export type RenderStatus = "ok" | "error"
/** Engine vẽ (FLF-339): `puml` = text PlantUML qua server; `svg` = SVG tự dựng (`shared/diagram/svg-*`). */
export type DiagramFormat = "puml" | "svg"

export interface Diagram {
  id: string
  kind: DiagramKind
  format: DiagramFormat
  /** Nguồn hình: text PlantUML (`format = puml`) hoặc markup SVG đầy đủ (`format = svg`). */
  source: string
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
  /** Bản ngôn ngữ của user (FLF-221); Spine cũ không có ⇒ hiện `statement`. */
  statement_vi?: string | null
  rationale: string
  /** Lý do bằng ngôn ngữ user (hiện ở cổng duyệt); Spine cũ không có. */
  rationale_vi?: string | null
  origin_step_id: string
  status: AssumptionStatus
  confirmed_at: IsoDateTime | null
}

/**
 * Một quyết định của user đã chốt trong lúc hỏi đáp (FLF-208 · `02-reduce-stops-plan.md` R4).
 *
 * Lượt test bị hỏi lại uptime ba lần và "giữ chỗ 15 phút" ba lần, rồi AI còn gợi ý ngược với điều user đã
 * chốt. Sổ này là bộ nhớ chung của mọi step: hỏi xong ghi vào đây, và mọi lượt hỏi sau đều đọc nó.
 * `topic_key` là khoá chủ đề (`uptime`, `slot_hold_minutes`…) — trùng khoá nghĩa là đã hỏi rồi.
 */
export interface Decision {
  id: string
  topic_key: string
  question: string
  answer: string
  /** Step đã hỏi ra quyết định này. */
  step_id: string
  at: IsoDateTime
  /** Quyết định mới thay thế nó (user đổi ý) — giữ lại vết thay vì xoá. */
  superseded_by: string | null
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
  /** Bắt buộc ≥ 20 ký tự khi waive (srs-spine.md §7). Chỉ cờ vàng (FLF-329). */
  waive_reason: string | null
  waived_at_version: number | null
  /**
   * "Giữ nguyên + lý do" (FLF-329, BR-04): người dùng ghi vì sao không sửa — cờ **vẫn mở, vẫn chặn** baseline /
   * gửi gói / phát hành. Dữ liệu trước FLF-329 không có ba field này ⇒ đọc ra `null`.
   */
  kept_reason: string | null
  kept_by: string | null
  kept_at: IsoDateTime | null
}

/** `status` KHÔNG lưu — là hàm tính (srs-spine.md §5, T09). */
export interface SectionState {
  id: string
  asset_version: string
}

/**
 * Nguồn gốc baseline (FLF-171, mode 1):
 * - `generated` — ký ở S-9.5 của quy trình sinh SRS (mode 2); dữ liệu cũ không có field này đọc ra `generated`.
 * - `imported` — baseline v0 tạo khi import SRS có sẵn (mode 1, nút 1.10).
 * - `release` — Lead release bản major ở mode 1 (Flow 6).
 */
export type BaselineType = "generated" | "imported" | "release"

export interface Baseline {
  id: string
  /** Mode 2: `v1.0`, `v1.1`… Mode 1: `0.0`, `1.0`, `2.0`… */
  version: string
  type: BaselineType
  /** Mode 1: version tài liệu (`DocVersion.version`) mà baseline chụp; mode 2 luôn `null`. */
  doc_version: string | null
  at: IsoDateTime
  /** `_id` của document trong collection `baselines` (snapshot). */
  snapshot_ref: string
  checked_at_version: number
  waived_count: number
}

export type BaselineSubmissionStatus = "pending" | "rejected"

/**
 * Lượt nộp baseline đang chờ Lead quyết, hoặc lượt vừa bị Lead từ chối. `null` = chưa ai nộp —
 * Lead tự duyệt đi thẳng từ trạng thái này. Lịch sử nộp/từ chối suy được từ `changes[]`, không lưu thêm.
 */
export interface BaselineSubmission {
  status: BaselineSubmissionStatus
  submitted_by: string
  submitted_at: IsoDateTime
  /** `spine_version` lúc nộp — Lead biết tài liệu có đổi sau khi nộp hay không. */
  spine_version: number
  decided_by: string | null
  decided_at: IsoDateTime | null
  /** Lý do từ chối; `null` khi đang chờ duyệt. */
  reason: string | null
  /** `CM-nnn` Lead ghim kèm lần từ chối — phải kết luận hết mới nộp lại được. */
  rejection_comment_ids: string[]
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
  custom_sections: CustomSection[]

  diagrams: Diagram[]
  assumptions: Assumption[]
  /** Sổ quyết định đã chốt (R4) — Spine cũ không có ⇒ `[]`. */
  decisions: Decision[]
  flags: Flag[]
  sections: SectionState[]
  baselines: Baseline[]
  /** Lượt nộp baseline đang chờ Lead quyết hoặc vừa bị từ chối. Spine cũ không có ⇒ `null`. */
  baseline_submission: BaselineSubmission | null

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
  type: BaselineType
  doc_version: string | null
  at: IsoDateTime
  checked_at_version: number
  waived_count: number
  snapshot: Spine
}
