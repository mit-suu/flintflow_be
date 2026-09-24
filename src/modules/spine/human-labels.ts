/**
 * human-labels.ts
 * ─────────────────────────────────────────────────────────────────
 * Nhãn cho người đọc thay cho mã kỹ thuật trong câu chữ BE sinh ra (thông điệp cờ, lỗi CR, gap report, thông báo):
 * path Spine (`use_cases[id=UC-01].description`), khoá section (`fixed:2.2.1`), mã luật cờ (`section_empty`),
 * loại sơ đồ, nhóm NFR. Chỉ đổi **chữ hiển thị** — field máy trong JSON (`rule_id`, `section_id`, `path`) giữ nguyên.
 *
 * Bảng nhãn chép theo FE (`app/projects/[id]/_components/mode1/spine-labels.ts`) để hai phía nói cùng một chữ.
 * Khác FE: path/khoá không đọc được ⇒ nhãn chung ("Một phần tử trong tài liệu"), không trả nguyên mã.
 */

import { FIXED_SECTIONS } from "./section-registry.js"
import type { Diagram, DiagramKind, NfrCategory, Spine } from "./spine.types.js"

export const ENTITY_LABELS: Readonly<Record<string, string>> = {
  project: "Thông tin dự án",
  features: "Tính năng",
  actors: "Tác nhân",
  roles: "Vai trò",
  use_cases: "Use case",
  screens: "Màn hình",
  permissions: "Phân quyền",
  entities: "Thực thể dữ liệu",
  functions: "Chức năng",
  validations: "Kiểm tra dữ liệu",
  nfrs: "Yêu cầu phi chức năng",
  business_rules: "Quy tắc nghiệp vụ",
  common_requirements: "Yêu cầu chung",
  messages: "Thông báo hệ thống",
  other_requirements: "Yêu cầu khác",
  glossary: "Thuật ngữ",
  addendum: "Ghi chú bổ sung",
  custom_sections: "Mục riêng",
  diagrams: "Sơ đồ",
  assumptions: "Giả định"
}

export const FIELD_LABELS: Readonly<Record<string, string>> = {
  id: "Mã",
  name: "Tên",
  description: "Mô tả",
  kind: "Loại",
  type: "Loại",
  aliases: "Tên khác",
  actor_id: "Tác nhân",
  actor_ids: "Tác nhân",
  function_ids: "Chức năng liên quan",
  includes: "Include",
  extends: "Extend",
  feature_id: "Tính năng",
  screen_id: "Màn hình",
  role_id: "Vai trò",
  action: "Thao tác",
  flow_to: "Chuyển tới màn",
  is_popup: "Là popup",
  tabs: "Tab",
  primary_function_id: "Chức năng chính",
  relations: "Quan hệ",
  order: "Thứ tự",
  trigger: "Điều kiện kích hoạt",
  normal: "Luồng chính",
  abnormal: "Luồng ngoại lệ",
  validations: "Kiểm tra dữ liệu",
  business_rule_ids: "Quy tắc nghiệp vụ",
  source_validation_ids: "Kiểm tra nguồn",
  priority: "Độ ưu tiên",
  statement: "Nội dung",
  category: "Nhóm",
  metric: "Chỉ số đo",
  threshold: "Ngưỡng",
  threshold_ms: "Ngưỡng (ms)",
  tier: "Mức",
  code: "Mã",
  text: "Nội dung",
  term: "Thuật ngữ",
  term_native: "Thuật ngữ (tiếng Việt)",
  definition: "Định nghĩa",
  heading: "Tiêu đề",
  blocks: "Nội dung",
  content: "Nội dung",
  topic: "Chủ đề",
  rationale: "Lý do",
  status: "Trạng thái",
  system_name: "Tên hệ thống",
  vision: "Tầm nhìn",
  goals: "Mục tiêu",
  domain: "Lĩnh vực",
  release_scope: "Phạm vi phát hành"
}

export const fieldLabel = (field: string): string => FIELD_LABELS[field] ?? field

/** Nhãn chung khi path không đọc được — không bao giờ in nguyên path. */
export const UNKNOWN_PATH_LABEL = "Một phần tử trong tài liệu"

const SEGMENT = /\.?([a-z_]+)(?:\[([^\]]*)\])?/y

const parsePathLabel = (path: string): string | null => {
  const parts: { name: string; selector: string | undefined }[] = []
  const re = new RegExp(SEGMENT.source, "y")
  let m: RegExpExecArray | null
  while (re.lastIndex < path.length && (m = re.exec(path))) parts.push({ name: m[1], selector: m[2] })
  if (!parts.length || re.lastIndex !== path.length || !(parts[0].name in ENTITY_LABELS)) return null

  const out: string[] = []
  let field: string | null = null
  for (const p of parts) {
    if (p.selector === undefined && p.name !== "project") {
      field = p.name
      continue
    }
    const label = ENTITY_LABELS[p.name] ?? fieldLabel(p.name)
    if (p.selector === undefined) out.push(label)
    else if (p.selector === "") out.push(`${label} (thêm mới)`)
    else {
      const key = p.selector.includes("=") ? p.selector.slice(p.selector.indexOf("=") + 1) : p.selector
      out.push(/^\d+$/.test(key) ? `${label} #${Number(key) + 1}` : `${label} ${key}`)
    }
    field = null
  }
  return field ? `${out.join(" › ")} — ${fieldLabel(field)}` : out.join(" › ")
}

/**
 * `use_cases[id=UC-2.4].description` ⇒ "Use case UC-2.4 — Mô tả"; `actors[]` ⇒ "Tác nhân (thêm mới)";
 * `project.code` ⇒ "Thông tin dự án — Mã". Không đọc được ⇒ "Một phần tử trong tài liệu".
 */
export const pathLabel = (path: string): string => parsePathLabel(path) ?? UNKNOWN_PATH_LABEL

const PATH_IN_TEXT = new RegExp(
  `\\b(?:project\\.[a-z_]+|(?:${Object.keys(ENTITY_LABELS).join("|")})\\[[^\\]\\s]*\\](?:\\.[a-z_]+(?:\\[[^\\]\\s]*\\])?)*)`,
  "g"
)

/** Đổi mọi path Spine nằm trong một câu (vd thông điệp bất biến của op engine) sang nhãn. */
export const humanizeText = (text: string): string => text.replace(PATH_IN_TEXT, (p) => parsePathLabel(p) ?? p)

// ─── section ─────────────────────────────────────────────────────

const FIXED_BY_ID: ReadonlyMap<string, { number: string; title: string }> = new Map(
  FIXED_SECTIONS.map((s) => [s.id, { number: s.id.slice("fixed:".length), title: s.title_en }])
)

type SectionSource = Partial<Pick<Spine, "features" | "functions" | "custom_sections">>

/**
 * Tên mục cho câu chữ: `fixed:5.5` ⇒ "5.5 Glossary" (tiêu đề mẫu FPT, như FE); `feature:F01` ⇒ `tính năng "Đăng nhập"`;
 * `custom:CS07` ⇒ `mục riêng "Phụ lục A"`. Id tạm `feature:@B0012`, id lạ ⇒ nhãn chung — không in khoá thô.
 * Chữ thường ở đầu (trừ số mục) để đặt giữa câu; đầu câu thì `capitalize`.
 */
export const sectionLabel = (sectionId: string | null | undefined, spine?: SectionSource): string => {
  if (!sectionId) return "một mục của tài liệu"
  const fixed = FIXED_BY_ID.get(sectionId)
  if (fixed) return `${fixed.number} ${fixed.title}`
  const at = sectionId.indexOf(":")
  const kind = at >= 0 ? sectionId.slice(0, at) : sectionId
  const key = at >= 0 ? sectionId.slice(at + 1) : ""
  if (kind === "group") return `mục ${key}`
  if (kind === "feature") {
    if (key === "*") return "các tính năng"
    const name = spine?.features?.find((f) => f.id === key)?.name
    return name ? `tính năng "${name}"` : key.startsWith("@") ? "tính năng (chưa đặt mã)" : `tính năng ${key}`
  }
  if (kind === "function") {
    const name = spine?.functions?.find((f) => f.id === key)?.name
    return name ? `chức năng "${name}"` : key.startsWith("@") ? "chức năng (chưa đặt mã)" : `chức năng ${key}`
  }
  if (kind === "custom") {
    const heading = spine?.custom_sections?.find((c) => c.id === key)?.heading.trim()
    return heading ? `mục riêng "${heading}"` : "mục riêng"
  }
  if (sectionId === "unmapped") return "mục không khớp mẫu"
  return "một mục của tài liệu"
}

/** Như `sectionLabel`, mục cố định có thêm ngoặc kép: `Mục "5.5 Glossary"` / `Nội dung tính năng "Auth"`. */
export const quotedSectionLabel = (sectionId: string | null | undefined, spine?: SectionSource): string =>
  sectionId && FIXED_BY_ID.has(sectionId) ? `"${sectionLabel(sectionId, spine)}"` : sectionLabel(sectionId, spine)

// ─── luật cờ ─────────────────────────────────────────────────────

export const RULE_LABELS: Readonly<Record<string, string>> = {
  // cờ của tài liệu (deterministic-check + cờ do AI đặt)
  section_empty: "Mục còn trống",
  array_empty: "Danh sách còn trống",
  dead_reference: "Tham chiếu tới phần không tồn tại",
  render_error: "Lỗi vẽ sơ đồ",
  diagram_stale: "Sơ đồ chưa cập nhật",
  original_diagram_stale: "Hình gốc lệch dữ liệu",
  nfr_missing_number: "Yêu cầu phi chức năng thiếu số đo",
  usecase_relation_invalid: "Quan hệ include/extend không hợp lệ",
  unconfirmed_assumption: "Giả định chưa xác nhận",
  section_stale_at_baseline: "Mục cần xem lại",
  section_awaiting_reaccept: "Mục chờ chấp nhận lại",
  screen_pending_at_baseline: "Màn hình chưa mô tả xong",
  orphan_screen_at_baseline: "Màn hình không nằm trong luồng nào",
  orphan_screen: "Màn hình không nằm trong luồng nào",
  orphan_actor: "Tác nhân chưa gắn use case",
  usecase_no_function: "Use case chưa gắn chức năng",
  screen_no_function: "Màn hình chưa có chức năng",
  empty_feature: "Tính năng chưa có màn hình hay chức năng",
  role_no_actor: "Vai trò chưa gắn tác nhân",
  non_english_content: "Nội dung chưa phải tiếng Anh",
  usecase_floating: "Use case không gắn tác nhân",
  usecase_auth_relation: "Use case đăng nhập đặt sai quan hệ",
  usecase_name_semantic: "Tên use case chưa rõ nghĩa",
  usecase_name_style: "Tên use case chưa đúng dạng",
  actor_name_shape: "Tên tác nhân chưa đúng dạng",
  system_name_missing: "Thiếu tên hệ thống",
  screen_placeholder: "Màn hình còn để trống",
  derived_from_changed_assumption: "Dựa trên giả định đã đổi",
  function_without_uc: "Chức năng chưa thuộc use case nào",
  import_semantic: "AI phát hiện vấn đề nội dung",
  import_image_unread: "Ảnh chưa đọc được",
  accepted_as_is: "Chấp nhận nguyên trạng",
  goal_not_covered: "Mục tiêu chưa được đáp ứng",
  cr_consistency: "Chưa nhất quán sau khi sửa",
  // luật kiểm đề xuất CR (3.7)
  unconcluded: "Chưa có kết luận",
  element_missing: "Phần tử không còn trong tài liệu",
  path_not_locked: "Chưa được khoá cho CR này",
  no_proposal: "Thiếu đề xuất",
  edit_without_ops: "Kết luận sửa nhưng chưa có nội dung sửa",
  edit_no_change: "Đề xuất không thay đổi gì",
  op_path_not_locked: "Sửa vào phần CR không giữ",
  op_outside_section: "Sửa ngoài phạm vi của vị trí",
  comment_empty: "Comment còn trống",
  op_invalid: "Nội dung sửa sai định dạng",
  new_red_flag: "Làm phát sinh lỗi đỏ mới"
}

/** Mã lạ ⇒ chuỗi rỗng: câu thông điệp đã đủ nghĩa (như FE). */
export const ruleLabel = (ruleId: string): string => RULE_LABELS[ruleId] ?? ""

/** Nhận xét do AI đặt tên (`rule` trong output `findings` của skill import-semantic-check / cr-consistency). */
export const AI_FINDING_LABELS: Readonly<Record<string, string>> = {
  ambiguity: "Diễn đạt mơ hồ",
  fr_nfr_conflict: "Chức năng mâu thuẫn yêu cầu phi chức năng",
  semantic_duplicate: "Trùng ý",
  term_drift: "Thuật ngữ không thống nhất",
  missing_acceptance: "Thiếu kết quả kiểm chứng được",
  contradiction: "Mâu thuẫn",
  dangling_reference: "Còn nhắc tới phần đã đổi",
  incomplete_edit: "Sửa chưa đủ"
}

export const aiFindingLabel = (rule: string): string => AI_FINDING_LABELS[rule] ?? ""

// ─── sơ đồ, NFR ──────────────────────────────────────────────────

export const DIAGRAM_KIND_LABELS: Readonly<Record<DiagramKind, string>> = {
  context: "sơ đồ ngữ cảnh",
  usecase: "sơ đồ use case",
  screen_flow: "sơ đồ luồng màn hình",
  erd: "sơ đồ ERD",
  screen_layout: "bố cục màn hình"
}

export const NFR_CATEGORY_LABELS: Readonly<Record<NfrCategory, string>> = {
  interface: "giao tiếp ngoài",
  usability: "khả năng sử dụng",
  reliability: "độ tin cậy",
  performance: "hiệu năng",
  other: "thuộc tính khác"
}

/**
 * Sơ đồ trong câu chữ, không in id hình hay mã loại: `sơ đồ use case (mục "2.2.1 Use Case Diagram")`,
 * `bố cục màn hình "Login"`.
 */
export const diagramLabel = (
  d: Pick<Diagram, "kind" | "owner_id" | "section">,
  spine?: SectionSource & Partial<Pick<Spine, "screens">>
): string => {
  const kind = DIAGRAM_KIND_LABELS[d.kind] ?? "sơ đồ"
  if (d.kind === "screen_layout") {
    const owner = spine?.screens?.find((s) => s.id === d.owner_id)?.name ?? spine?.functions?.find((f) => f.id === d.owner_id)?.name
    return owner ? `${kind} "${owner}"` : kind
  }
  return `${kind} (mục ${quotedSectionLabel(d.section, spine)})`
}

export const capitalize =(text: string): string => (text ? text[0].toUpperCase() + text.slice(1) : text)
