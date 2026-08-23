/**
 * Nguồn định nghĩa duy nhất cho SectionType và metadata trong FlintFlow backend.
 * Khớp 100% với enum trong section.model.ts và file constants phía FE.
 *
 * Phân loại theo SRS Capstone Report 3:
 * - Phase 2 (Foundation / Discovery): 7 loại (toàn bộ mappedToTemplate: true)
 * - Phase 3 (Core Functional Specification): 10 loại (8 mappedToTemplate: true, 2 false)
 * - Phase 4 (Non-functional & Finalization): 8 loại (7 mappedToTemplate: true, 1 false)
 *
 * Tổng cộng: 25 loại (22 mappedToTemplate = true, 3 mappedToTemplate = false).
 */

export const SECTION_TYPE_VALUES = [
  // Phase 2
  "vision_problem",
  "business_goals",
  "value_proposition",
  "high_level_business_rules",
  "stakeholders",
  "user_journey",
  "use_case_spec",

  // Phase 3
  "screen_flow",
  "screen_description",
  "rbac",
  "non_screen_functions",
  "erd",
  "functional_requirements",
  "user_story",
  "acceptance_criteria",
  "priority_ranking",
  "scope_out_of_scope",

  // Phase 4
  "external_interfaces",
  "non_functional_requirements",
  "common_business_rules",
  "common_requirements",
  "application_messages",
  "assumptions_risks",
  "glossary",
  "success_metrics"
] as const

export type SectionType = (typeof SECTION_TYPE_VALUES)[number]

export interface SectionTypeMetadata {
  phase: 2 | 3 | 4
  mappedToTemplate: boolean
  label: string
  order: number
}

export const SECTION_METADATA: Record<SectionType, SectionTypeMetadata> = {
  // ─── Phase 2 (Foundation & Overview) ───────────────────────────────────────
  vision_problem: {
    phase: 2,
    mappedToTemplate: true,
    label: "Vision & Problem (Tầm nhìn & Vấn đề)",
    order: 1
  },
  business_goals: {
    phase: 2,
    mappedToTemplate: true,
    label: "Business Goals (Mục tiêu kinh doanh)",
    order: 2
  },
  value_proposition: {
    phase: 2,
    mappedToTemplate: true,
    label: "Value Proposition (Giá trị cốt lõi)",
    order: 3
  },
  high_level_business_rules: {
    phase: 2,
    mappedToTemplate: true,
    label: "High-Level Business Rules (Quy tắc nghiệp vụ cấp cao)",
    order: 4
  },
  stakeholders: {
    phase: 2,
    mappedToTemplate: true,
    label: "Stakeholders / Target Users (Đối tượng người dùng mục tiêu)",
    order: 5
  },
  user_journey: {
    phase: 2,
    mappedToTemplate: true,
    label: "User Journey (Hành trình người dùng)",
    order: 6
  },
  use_case_spec: {
    phase: 2,
    mappedToTemplate: true,
    label: "Use Case Specification (Đặc tả ca sử dụng)",
    order: 7
  },

  // ─── Phase 3 (Core Functional Specification) ──────────────────────────────
  screen_flow: {
    phase: 3,
    mappedToTemplate: true,
    label: "Screen Flow (Luồng màn hình)",
    order: 8
  },
  screen_description: {
    phase: 3,
    mappedToTemplate: true,
    label: "Screen Description (Mô tả màn hình & UI elements)",
    order: 9
  },
  rbac: {
    phase: 3,
    mappedToTemplate: true,
    label: "RBAC (Phân quyền người dùng & vai trò)",
    order: 10
  },
  non_screen_functions: {
    phase: 3,
    mappedToTemplate: true,
    label: "Non-Screen Functions (Chức năng ngầm / background jobs / triggers)",
    order: 11
  },
  erd: {
    phase: 3,
    mappedToTemplate: true,
    label: "Entity Relationship Diagram (ERD & mô hình thực thể)",
    order: 12
  },
  functional_requirements: {
    phase: 3,
    mappedToTemplate: true,
    label: "Functional Requirements (Yêu cầu chức năng chi tiết)",
    order: 13
  },
  user_story: {
    phase: 3,
    mappedToTemplate: true,
    label: "User Stories (Câu chuyện người dùng & acceptance scenarios)",
    order: 14
  },
  acceptance_criteria: {
    phase: 3,
    mappedToTemplate: true,
    label: "Acceptance Criteria (Tiêu chí nghiệm thu Gherkin Given-When-Then)",
    order: 15
  },
  priority_ranking: {
    phase: 3,
    mappedToTemplate: false, // Internal-only: MoSCoW feature ranking
    label: "Priority Ranking (Thứ tự ưu tiên MoSCoW)",
    order: 16
  },
  scope_out_of_scope: {
    phase: 3,
    mappedToTemplate: false, // Internal-only: Scope boundary
    label: "Scope & Out of Scope (Phạm vi & Ngoài phạm vi)",
    order: 17
  },

  // ─── Phase 4 (Non-functional & Finalization) ───────────────────────────────
  external_interfaces: {
    phase: 4,
    mappedToTemplate: true,
    label: "External Interfaces (Giao tiếp hệ thống ngoài / 3rd-party APIs)",
    order: 18
  },
  non_functional_requirements: {
    phase: 4,
    mappedToTemplate: true,
    label: "Non-Functional Requirements (Yêu cầu phi chức năng / SLA)",
    order: 19
  },
  common_business_rules: {
    phase: 4,
    mappedToTemplate: true,
    label: "Common Business Rules (Quy tắc nghiệp vụ chung toàn hệ thống)",
    order: 20
  },
  common_requirements: {
    phase: 4,
    mappedToTemplate: true,
    label: "Common Requirements (Yêu cầu chung về logging, auditing, i18n)",
    order: 21
  },
  application_messages: {
    phase: 4,
    mappedToTemplate: true,
    label: "Application Messages (Thông báo hệ thống / mã lỗi / validation)",
    order: 22
  },
  assumptions_risks: {
    phase: 4,
    mappedToTemplate: true,
    label: "Assumptions & Risks (Giả định & Rủi ro kỹ thuật / vận hành)",
    order: 23
  },
  glossary: {
    phase: 4,
    mappedToTemplate: true,
    label: "Glossary (Thuật ngữ chuyên ngành & viết tắt)",
    order: 24
  },
  success_metrics: {
    phase: 4,
    mappedToTemplate: false, // Internal-only
    label: "Success Metrics (Chỉ số đo lường thành công dự án)",
    order: 25
  }
}

export const SECTION_TYPE_SET = new Set<string>(SECTION_TYPE_VALUES)

export const isSectionType = (value: string): value is SectionType => {
  return SECTION_TYPE_SET.has(value)
}

/**
 * Lấy danh sách SectionType theo phase (2, 3, hoặc 4).
 */
export const getSectionsByPhase = (phase: 2 | 3 | 4): SectionType[] => {
  return SECTION_TYPE_VALUES.filter((type) => SECTION_METADATA[type].phase === phase)
}

/**
 * Lấy danh sách SectionType có mappedToTemplate = true theo phase.
 * Dùng cho logic Phase Gate: tất cả section này phải được accept để unlock phase tiếp theo.
 */
export const getMappedSectionsByPhase = (phase: 2 | 3 | 4): SectionType[] => {
  return SECTION_TYPE_VALUES.filter(
    (type) => SECTION_METADATA[type].phase === phase && SECTION_METADATA[type].mappedToTemplate
  )
}

/**
 * Lấy toàn bộ danh sách SectionType có mappedToTemplate = true trên toàn bộ 3 phase.
 * Dùng để tính tổng số section export và progress percent (tổng = 22).
 */
export const getAllMappedSections = (): SectionType[] => {
  return SECTION_TYPE_VALUES.filter((type) => SECTION_METADATA[type].mappedToTemplate)
}

// ─── WorkspacePhase (UI-level & workflow phase) ──────────────────────────────

export type WorkspacePhase =
  | "discovery"
  | "product_overview"
  | "functional_spec"
  | "nfr_appendix"
  | "export"

export const WORKSPACE_PHASE_MAP: Record<
  WorkspacePhase,
  { sectionTypes: SectionType[]; label: string; backendPhase?: 2 | 3 | 4 }
> = {
  discovery: {
    sectionTypes: [],
    label: "Discovery & Elicitation"
  },
  product_overview: {
    sectionTypes: [
      "vision_problem",
      "business_goals",
      "value_proposition",
      "high_level_business_rules",
      "stakeholders",
      "user_journey",
      "use_case_spec"
    ],
    label: "Product Overview",
    backendPhase: 2
  },
  functional_spec: {
    sectionTypes: [
      "screen_flow",
      "screen_description",
      "rbac",
      "non_screen_functions",
      "erd",
      "functional_requirements",
      "user_story",
      "acceptance_criteria",
      "priority_ranking",
      "scope_out_of_scope"
    ],
    label: "Core Functional Spec",
    backendPhase: 3
  },
  nfr_appendix: {
    sectionTypes: [
      "external_interfaces",
      "non_functional_requirements",
      "common_business_rules",
      "common_requirements",
      "application_messages",
      "assumptions_risks",
      "glossary",
      "success_metrics"
    ],
    label: "NFR & Appendix",
    backendPhase: 4
  },
  export: {
    sectionTypes: [],
    label: "Export & Handoff"
  }
}

