/**
 * labels.ts
 * ─────────────────────────────────────────────────────────────────
 * Bảng nhãn cố định theo ngôn ngữ tài liệu (FLF-265, D13/D14): mọi chữ do renderer / assemble / docx-writer tự sinh
 * (tiêu đề cột, heading con, nhãn mục con, chú thích hình, câu ghép, nhãn enum, §I, bìa, mục lục…) gom về một chỗ.
 * Nội dung Spine KHÔNG đi qua đây — chỉ chữ của máy; giá trị Spine chèn vào mẫu câu giữ nguyên.
 *
 * Hai lớp, để bản mode 1 (tài liệu nhập) không đổi byte nào:
 *  - `VI_LABELS` / `VI_SECTION_TITLES` — bảng có từ FLF-184, dùng cho cả đường layout mode 1 (`layout-sections.ts`).
 *    KHÔNG thêm key vào hai bảng này: thêm là đổi bản in mode 1 tiếng Việt.
 *  - Mọi bảng còn lại (`VI_FPT_LABELS`, enum, câu ghép, nhóm heading, nhãn phase, chữ của writer) chỉ dùng khi tài
 *    liệu theo mẫu FPT (mode 2 — `assemble.service#buildSections`) được yêu cầu ra tiếng Việt.
 * Không truyền ngôn ngữ (mặc định) ⇒ tiếng Anh, y như trước.
 */

import type { ActorKind, NfrCategory, OtherRequirementKind, Priority, ValidationKind } from "../spine/spine.types.js"

/** Ngôn ngữ tài liệu render — controller đặt từ `translation.service#projectLanguages` (FLF-265 §3.1), không từ query. */
export type DocumentLanguage = "vi" | "en"

export const isVietnamese = (language: string | undefined): boolean => !!language && language.toLowerCase().startsWith("vi")

// ─── nhãn dùng chung mode 1 + mode 2 (FLF-184) ─────────────────────

/**
 * Tiêu đề cột bảng, heading con, chú thích hình mà renderer tự sinh. Mặc định tiếng Anh (mode 2); tài liệu import
 * tiếng Việt (`TemplateProfile.language = "vi"`) dùng bản dịch dưới — nội dung Spine giữ nguyên, chỉ đổi nhãn.
 */
export const VI_LABELS: Readonly<Record<string, string>> = {
  ID: "Mã",
  Name: "Tên",
  Kind: "Loại",
  Description: "Mô tả",
  Actors: "Tác nhân",
  Screen: "Màn hình",
  Type: "Kiểu",
  Feature: "Chức năng",
  "System Function": "Chức năng hệ thống",
  Trigger: "Kích hoạt",
  Entity: "Thực thể",
  Relations: "Quan hệ",
  Statement: "Yêu cầu",
  Metric: "Chỉ số",
  Threshold: "Ngưỡng",
  Priority: "Ưu tiên",
  Category: "Nhóm",
  Code: "Mã",
  Text: "Nội dung",
  Functions: "Chức năng",
  Term: "Thuật ngữ",
  Native: "Tiếng Việt",
  Definition: "Định nghĩa",
  Goals: "Mục tiêu",
  "Release 1.0 Scope": "Phạm vi phát hành 1.0",
  "In Scope": "Trong phạm vi",
  "Out of Scope": "Ngoài phạm vi",
  "High-Level Business Rules": "Quy tắc nghiệp vụ tổng quát",
  "External Systems": "Hệ thống bên ngoài",
  "Normal Flow": "Luồng chính",
  "Abnormal Flow": "Luồng ngoại lệ",
  Validations: "Kiểm tra dữ liệu",
  "Business Rules": "Quy tắc nghiệp vụ",
  Screens: "Màn hình",
  "Figure — System Context Diagram": "Hình — Sơ đồ ngữ cảnh hệ thống",
  "Use Case Diagram": "Sơ đồ use case",
  "Screens Flow Diagram": "Sơ đồ luồng màn hình",
  "Screens flow for": "Luồng màn hình của",
  "Entity Relationship Diagram": "Sơ đồ quan hệ thực thể",
  "Screen Layout": "Bố cục màn hình"
}

/** Tiêu đề section FPT tiếng Việt — dùng khi assemble chèn mục FPT mà file người dùng không có. */
export const VI_SECTION_TITLES: Readonly<Record<string, string>> = {
  "fixed:1": "Tổng quan sản phẩm",
  "fixed:2.1": "Tác nhân",
  "fixed:2.2.1": "Sơ đồ use case",
  "fixed:2.2.2": "Đặc tả use case",
  "fixed:3.1.1": "Luồng màn hình",
  "fixed:3.1.2": "Mô tả màn hình",
  "fixed:3.1.3": "Phân quyền màn hình",
  "fixed:3.1.4": "Chức năng không có màn hình",
  "fixed:3.1.5": "Sơ đồ quan hệ thực thể",
  "fixed:4.1": "Giao tiếp hệ thống ngoài",
  "fixed:4.2.1": "Tính khả dụng",
  "fixed:4.2.2": "Độ tin cậy",
  "fixed:4.2.3": "Hiệu năng",
  "fixed:4.2.4": "Thuộc tính đặc thù",
  "fixed:5.1": "Quy tắc nghiệp vụ",
  "fixed:5.2": "Yêu cầu chung",
  "fixed:5.3": "Danh sách thông báo",
  "fixed:5.4": "Yêu cầu khác",
  "fixed:5.5": "Thuật ngữ"
}

/** Nhãn cố định theo ngôn ngữ — thiếu bản dịch ⇒ giữ tiếng Anh. Bảng của mode 1 (không đổi). */
export const labelFor = (language: string | undefined, text: string): string => (isVietnamese(language) ? (VI_LABELS[text] ?? text) : text)

// ─── nhãn riêng của mẫu FPT (mode 2) ──────────────────────────────

/** `VI_LABELS` + các nhãn chỉ mẫu FPT sinh ra (bảng use case, ma trận quyền, khung §3.x.y, `N/A`…). */
export const VI_FPT_LABELS: Readonly<Record<string, string>> = {
  ...VI_LABELS,
  "Use Case": "Use case",
  "Use Case Description": "Mô tả use case",
  Includes: "Bao gồm",
  Extends: "Mở rộng",
  Role: "Vai trò",
  Actor: "Tác nhân",
  "#": "STT",
  "N/A": "Không có",
  // Khung §3.x.y mẫu FPT
  "Function trigger": "Kích hoạt chức năng",
  "Function description": "Mô tả chức năng",
  "Screen layout": "Bố cục màn hình",
  "Function details": "Chi tiết chức năng",
  // 11 nhãn mục con
  "Navigation path": "Đường dẫn điều hướng",
  "Timing frequency": "Thời điểm / tần suất",
  "Actors / Roles": "Tác nhân / Vai trò",
  Purpose: "Mục đích",
  Interface: "Giao diện",
  "Data processing": "Xử lý dữ liệu",
  Data: "Dữ liệu",
  Validation: "Kiểm tra dữ liệu",
  "Business rules": "Quy tắc nghiệp vụ",
  "Normal case": "Trường hợp thông thường",
  "Abnormal case": "Trường hợp ngoại lệ",
  "(optional)": "(không bắt buộc)",
  // Động từ quan hệ mặc định của ERD (`erd.renderer#DEFAULT_RELATION_VERB`)
  has: "có"
}

/** Nhãn FPT theo ngôn ngữ — thiếu bản dịch ⇒ giữ tiếng Anh. */
export const fptLabelFor = (language: string | undefined, text: string): string => (isVietnamese(language) ? (VI_FPT_LABELS[text] ?? text) : text)

// ─── nhãn enum (giá trị máy trong ô bảng) ─────────────────────────

/**
 * Giá trị enum Spine in ra bảng (`actors[].kind`, `permissions[].action`…). Tiếng Anh in nguyên giá trị như trước;
 * tiếng Việt tra bảng, giá trị lạ (chuỗi tự do như `permissions[].action`, `common_requirements[].category`) giữ nguyên.
 */
export const VI_ENUM_LABELS = {
  actor_kind: { human: "người dùng", system: "hệ thống", time: "thời gian" } satisfies Record<ActorKind, string>,
  validation_kind: { business: "nghiệp vụ", format: "định dạng", required: "bắt buộc" } satisfies Record<ValidationKind, string>,
  permission_action: {
    view: "xem",
    read: "xem",
    create: "tạo",
    update: "cập nhật",
    edit: "sửa",
    delete: "xoá",
    approve: "duyệt",
    reject: "từ chối",
    export: "xuất",
    import: "nhập",
    manage: "quản lý",
    assign: "phân công",
    comment: "bình luận",
    share: "chia sẻ"
  } as Readonly<Record<string, string>>,
  priority: { must: "Phải có", should: "Nên có", could: "Có thể có", wont: "Không làm" } satisfies Record<Priority, string>,
  nfr_category: {
    interface: "giao tiếp",
    usability: "tính khả dụng",
    reliability: "độ tin cậy",
    performance: "hiệu năng",
    other: "khác"
  } satisfies Record<NfrCategory, string>,
  common_category: {
    pagination: "Phân trang",
    date_format: "Định dạng ngày giờ",
    error_handling: "Xử lý lỗi",
    audit: "Nhật ký kiểm tra",
    session: "Phiên làm việc",
    security: "Bảo mật",
    logging: "Ghi nhật ký",
    validation: "Kiểm tra dữ liệu",
    notification: "Thông báo",
    localization: "Bản địa hoá",
    accessibility: "Khả năng tiếp cận"
  } as Readonly<Record<string, string>>,
  other_kind: {
    risk: "Rủi ro",
    assumption: "Giả định",
    open_question: "Câu hỏi mở",
    technical_risk: "Rủi ro kỹ thuật"
  } satisfies Record<OtherRequirementKind, string>
} as const

export type EnumTable = keyof typeof VI_ENUM_LABELS

export const enumLabel = (language: string | undefined, table: EnumTable, value: string): string =>
  isVietnamese(language) ? ((VI_ENUM_LABELS[table] as Readonly<Record<string, string>>)[value] ?? value) : value

// ─── câu ghép (glue word theo ngôn ngữ, giá trị Spine chèn nguyên) ──

export interface RenderSentences {
  /** §1 External Systems: `Stripe (system) — Payment gateway`; `kind` đã qua `enumLabel`. */
  externalSystem: (name: string, kind: string, description: string) => string
  /** §3.1.2 cột Feature: `3.2 Authentication`. */
  featureLabel: (number: string | undefined, name: string) => string
  /** §3.1.5 cột Relations: `has Order (optional)`. */
  relation: (verb: string, target: string, optional: boolean) => string
  /** Chú thích wireframe §3.x.y: `Screen Layout — Login`. */
  screenLayoutCaption: (screenName: string) => string
  /** §4.1: `stmt (metric: threshold)`. */
  nfrStatement: (statement: string, metric: string, threshold: string) => string
}

export const SENTENCES: Readonly<Record<DocumentLanguage, RenderSentences>> = {
  en: {
    externalSystem: (name, kind, description) => `${name} (${kind}) — ${description}`,
    featureLabel: (number, name) => (number ? `${number} ${name}` : name),
    relation: (verb, target, optional) => `${verb} ${target}${optional ? " (optional)" : ""}`,
    screenLayoutCaption: (screenName) => `Screen Layout — ${screenName}`,
    nfrStatement: (statement, metric, threshold) => `${statement} (${metric}: ${threshold})`
  },
  vi: {
    externalSystem: (name, kind, description) => `${name} (${kind}) — ${description}`,
    featureLabel: (number, name) => (number ? `${number} ${name}` : name),
    relation: (verb, target, optional) => `${verb} ${target}${optional ? ` ${VI_FPT_LABELS["(optional)"]}` : ""}`,
    screenLayoutCaption: (screenName) => `${VI_LABELS["Screen Layout"]} — ${screenName}`,
    nfrStatement: (statement, metric, threshold) => `${statement} (${metric}: ${threshold})`
  }
}

export const sentencesFor = (language: string | undefined): RenderSentences => SENTENCES[isVietnamese(language) ? "vi" : "en"]

// ─── mục "Interface" (§3.x.y) — câu từ wireframe ─────────────────

/** Loại widget nhận dạng từ wireframe salt (`interface-description.ts`). */
export type WidgetKind = "checkbox" | "option" | "button" | "dropdown" | "link" | "input" | "tabs" | "table" | "area" | "text_area" | "text"

/** Tên loại widget tiếng Việt — đứng TRƯỚC chữ trên widget (`nút Log in`); chữ trên widget giữ nguyên từ puml. */
export const VI_WIDGET_LABELS: Readonly<Record<WidgetKind, string>> = {
  checkbox: "ô chọn",
  option: "lựa chọn",
  button: "nút",
  dropdown: "danh sách chọn",
  link: "liên kết",
  input: "ô nhập",
  tabs: "các tab",
  table: "bảng",
  area: "vùng",
  text_area: "ô nhập nhiều dòng",
  text: "chữ"
}

/** Phụ chú của ô nhập: ẩn ký tự / khoảng giá trị. */
export const VI_WIDGET_NOTES = { masked: "ẩn", range: "khoảng" } as const

/** Câu "Interface": `Login screen: …` / `Màn hình Login: …`. */
export const interfaceSentence = (language: string | undefined, screenName: string, popup: boolean, body: string): string =>
  isVietnamese(language) ? `${popup ? "Pop-up" : "Màn hình"} ${screenName}: ${body}` : `${screenName} ${popup ? "pop-up" : "screen"}: ${body}`

// ─── assemble: heading nhóm, người ghi, chú thích ảnh chờ ──────────

/** Heading nhóm chèn lúc assemble (`assemble.service#GROUP_HEADINGS`). */
export const GROUP_HEADINGS: Readonly<Record<DocumentLanguage, Readonly<Record<string, string>>>> = {
  en: {
    "2": "User Requirements",
    "2.2": "Use Cases",
    "3": "Functional Requirements",
    "3.1": "System Functional Overview",
    "4": "Non-Functional Requirements",
    "4.2": "Quality Attributes",
    "5": "Requirement Appendix"
  },
  vi: {
    "2": "Yêu cầu người dùng",
    "2.2": "Use case",
    "3": "Yêu cầu chức năng",
    "3.1": "Tổng quan chức năng hệ thống",
    "4": "Yêu cầu phi chức năng",
    "4.2": "Thuộc tính chất lượng",
    "5": "Phụ lục yêu cầu"
  }
}

/** Chữ khác do assemble tự sinh. */
export const ASSEMBLE_TEXT = {
  en: {
    unassignedFunctions: "Unassigned Functions",
    systemInCharge: "System",
    removedSection: "(removed section)",
    imagePending: (diagramId: string) => `image pending: diagram ${diagramId} has not been rendered yet`,
    mediaNotEmbedded: "original image could not be embedded (unsupported format)"
  },
  vi: {
    unassignedFunctions: "Chức năng chưa thuộc tính năng nào",
    systemInCharge: "Hệ thống",
    removedSection: "(mục đã xoá)",
    imagePending: (diagramId: string) => `ảnh đang chờ: sơ đồ ${diagramId} chưa được render`,
    mediaNotEmbedded: "không nhúng được ảnh gốc (định dạng không hỗ trợ)"
  }
} as const

export const assembleTextFor = (language: string | undefined) => ASSEMBLE_TEXT[isVietnamese(language) ? "vi" : "en"]

// ─── §I Record of Changes (D14) ───────────────────────────────────

/**
 * Nhãn phase tiếng Việt theo id phase của `assets/step-registry.json` (file đóng băng chỉ có `phase_label_en`).
 * Phase không có ở đây ⇒ giữ nhãn tiếng Anh của registry.
 */
export const VI_PHASE_LABELS: Readonly<Record<string, string>> = {
  "B-0": "Tiếp nhận",
  "B-1": "Bản mô tả sản phẩm",
  "B-2": "Chốt bản mô tả sản phẩm",
  "S-1": "Phân tích & kiểm tra bản mô tả",
  "S-2": "Tổng quan sản phẩm",
  "S-3": "Yêu cầu người dùng",
  "S-4": "Tổng quan chức năng hệ thống",
  "S-5": "Chi tiết tính năng & chức năng",
  "S-6": "Yêu cầu phi chức năng",
  "S-7": "Phụ lục yêu cầu",
  "S-8": "Thuật ngữ & dựng tài liệu",
  "S-9": "Kiểm tra, thẩm định & baseline"
}

export const RECORD_TEXT = {
  en: {
    baselineSigned: "Baseline signed",
    documentUpdated: "Document updated",
    more: (n: number) => `; and ${n} more change${n > 1 ? "s" : ""}`,
    phaseRow: (first: boolean, phaseLabel: string) => `${first ? "Create" : "Update"} ${phaseLabel}`
  },
  vi: {
    baselineSigned: "Ký baseline",
    documentUpdated: "Cập nhật tài liệu",
    more: (n: number) => `; và ${n} thay đổi khác`,
    phaseRow: (first: boolean, phaseLabel: string) => `${first ? "Tạo" : "Cập nhật"} ${phaseLabel}`
  }
} as const

export const recordTextFor = (language: string | undefined) => RECORD_TEXT[isVietnamese(language) ? "vi" : "en"]

/**
 * Câu do MÁY ghi (tiếng Việt trong `changes[].reason`) ⇒ câu in ở §I theo ngôn ngữ tài liệu. Câu do user viết không
 * khớp mẫu nào ⇒ giữ nguyên văn (`docs/spec-gaps.md:43`).
 */
export const MACHINE_DESCRIPTIONS: readonly { re: RegExp; en: (m: RegExpExecArray) => string; vi: (m: RegExpExecArray) => string }[] = [
  { re: /^Ký baseline (.+)$/, en: (m) => `Baseline ${m[1]} signed`, vi: (m) => `Ký baseline ${m[1]}` },
  { re: /^Baseline (.+)$/, en: (m) => `Baseline ${m[1]} signed`, vi: (m) => `Ký baseline ${m[1]}` },
  { re: /^Hoà giải section stale$/, en: () => "Stale sections reconciled", vi: () => "Hoà giải các mục cần xem lại" },
  { re: /^Hoà giải: user xác nhận nội dung không đổi$/, en: () => "Reviewed: content still correct", vi: () => "Đã xem lại: nội dung vẫn đúng" },
  { re: /^sửa sau baseline$/, en: () => "Edited after baseline", vi: () => "Sửa sau baseline" },
  { re: /^User xác nhận giả định ở cổng chốt$/, en: () => "Assumptions confirmed", vi: () => "Xác nhận giả định" }
]

// ─── docx-writer ──────────────────────────────────────────────────

export interface WriterText {
  toc: string
  /** Core property `title`. */
  title: (projectName: string) => string
  /** Core property `description`. */
  description: (isDraft: boolean, version: string, generatedAt: string) => string
  coverTitle: string
  version: string
  date: string
  draftBanner: string
  baselineBanner: string
  /** Header mỗi trang: `<project> - SRS <version>`. */
  header: (projectName: string, version: string) => string
  /** Footer `Page x / y` — hai phần chữ quanh số trang. */
  footer: readonly [string, string]
  rocTitle: string
  rocLegend: string
  rocHeader: readonly string[]
  staleNote: string
  awaitingNote: string
}

export const WRITER_TEXT: Readonly<Record<DocumentLanguage, WriterText>> = {
  en: {
    toc: "Table of Contents",
    title: (projectName) => `${projectName} - Software Requirement Specification`,
    description: (isDraft, version, generatedAt) => `${isDraft ? "Working Draft" : "Baseline"} ${version} generated ${generatedAt}`,
    coverTitle: "Software Requirement Specification",
    version: "Version:",
    date: "Date:",
    draftBanner: "WORKING DRAFT - NOT BASELINED",
    baselineBanner: "BASELINE",
    header: (projectName, version) => `${projectName} - SRS ${version}`,
    footer: ["Page ", " / "],
    rocTitle: "I. Record of Changes",
    rocLegend: "*A - Added, M - Modified, D - Deleted",
    rocHeader: ["Date", "Version", "A*, M, D", "In charge", "Change Description"],
    staleNote: "[STALE] Source data of this section changed after it was accepted. Content below may be outdated.",
    awaitingNote: "[AWAITING RE-ACCEPT] This section was regenerated and is waiting for the user to accept it again."
  },
  vi: {
    toc: "Mục lục",
    title: (projectName) => `${projectName} - Đặc tả yêu cầu phần mềm`,
    description: (isDraft, version, generatedAt) => `${isDraft ? "Bản làm việc" : "Baseline"} ${version} tạo lúc ${generatedAt}`,
    coverTitle: "Đặc tả yêu cầu phần mềm",
    version: "Phiên bản:",
    date: "Ngày:",
    draftBanner: "BẢN LÀM VIỆC - CHƯA BASELINE",
    baselineBanner: "BASELINE",
    header: (projectName, version) => `${projectName} - SRS ${version}`,
    footer: ["Trang ", " / "],
    rocTitle: "I. Lịch sử thay đổi",
    rocLegend: "*A - Thêm, M - Sửa, D - Xoá",
    rocHeader: ["Ngày", "Phiên bản", "A*, M, D", "Người thực hiện", "Mô tả thay đổi"],
    staleNote: "[CẦN XEM LẠI] Dữ liệu nguồn của mục này đã đổi sau khi được chấp nhận. Nội dung dưới đây có thể đã cũ.",
    awaitingNote: "[CHỜ CHẤP NHẬN LẠI] Mục này vừa được tạo lại và đang chờ người dùng chấp nhận lại."
  }
}

/**
 * Chữ của phụ lục cờ. Mode 1 (tài liệu nhập): thông điệp cờ là tiếng Việt ⇒ tiêu đề cột + tên luật tiếng Việt, cột
 * luật in nhãn (`ruleLabel`) thay mã máy (`section_empty`). Mode 2 giữ nguyên tiếng Anh như trước.
 * Chọn theo `WriteDocxOptions.flagLanguage` (không theo `language` — bản version mode 1 phải giữ nguyên).
 */
export const FLAG_TEXT = {
  en: {
    status: "Working Draft Status",
    open: "Open red flags",
    stale: "Stale sections",
    waivedCount: "Waived flags",
    openHeading: "Open Red Flags",
    waivedHeading: "Waived Flags",
    header: ["ID", "Rule", "Section", "Message"],
    reason: "Waive reason"
  },
  vi: {
    status: "Tình trạng bản làm việc",
    open: "Lỗi đỏ đang mở",
    stale: "Mục cần xem lại",
    waivedCount: "Cờ đã bỏ qua",
    openHeading: "Lỗi đỏ đang mở",
    waivedHeading: "Cờ đã bỏ qua",
    header: ["Mã", "Loại lỗi", "Mục", "Nội dung"],
    reason: "Lý do bỏ qua"
  }
} as const

/**
 * FLF-265 §3.1 — tuỳ chọn `writeDocx` theo dự án, MỘT chỗ cho export và file version.
 * - Mode 1 (`import`): đúng tuỳ chọn trước FLF-265 — bìa / mục lục / §I mặc định, phụ lục cờ `vi` vì thông điệp cờ
 *   mode 1 là tiếng Việt (no-ky-thuat N6). Không theo `documentLanguage` để file mode 1 không đổi byte nào.
 * - Mode 2: chữ của writer + phụ lục cờ theo ngôn ngữ tài liệu (`en` = mặc định của writer, y như trước).
 * Trả object thường (khớp `WriteDocxOptions` theo cấu trúc) — bảng nhãn không import docx-writer.
 */
export const writerOptionsFor = (
  mode: string | null | undefined,
  documentLanguage: DocumentLanguage = "en"
): { language?: DocumentLanguage; flagLanguage: DocumentLanguage } =>
  mode === "import" ? { flagLanguage: "vi" } : { language: documentLanguage, flagLanguage: documentLanguage }
