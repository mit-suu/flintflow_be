/**
 * Ngân hàng phần chung FPT + IEEE (FLF-363) — thay cho danh mục riêng từng họ mẫu (`ieee830`, `ieee_features` của FLF-252).
 * Mỗi heading của file upload được so với **cả ngân hàng**, không đoán họ mẫu trước, **không dùng số mục**: chỉ tên + mục
 * cha + nội dung (bảng) quyết định phần. Hàm thuần / dữ liệu tĩnh.
 *
 * - Phần FPT dựng từ section registry + tên khác (`section-catalog.ts`); tên của mẫu IEEE mới (jam01 / ISO 29148, gộp cả
 *   IEEE 830, Wiegers "System Features", ReqView) thêm vào phần cùng đích. Phần chỉ có ở IEEE (References, Verification…)
 *   đích `keep` — giữ nguyên văn.
 * - `target`: section Spine (`fixed:*` / `group:*`), `keep`, `feature` (mục chính là một tính năng — IEEE 830 rút gọn) hoặc
 *   `parent` (mục con mô tả chính tính năng cha).
 * - `repeat`: mẫu thật có nhiều heading cùng nghĩa (Reliability + Availability, các loại giao diện…) ⇒ phần nhận nhiều
 *   heading; còn lại mỗi phần tối đa một heading (như danh mục cũ).
 * - `parents`: phần cha hợp lệ — tách tên trùng ở hai chỗ ("Overview" dưới Introduction = tổng quan tài liệu).
 * - `features`: mục con không khớp là tính năng (chương chức năng). `underFeature`: chỉ khớp khi nằm dưới một tính năng.
 * - Tên `weak` (quá chung: "Cost", "Requirements"…) vẫn khớp, nhưng không tính là dấu hiệu "là SRS" (`srs-detect.ts`).
 */

import { SECTION_CANDIDATES } from "./section-catalog.js"

export type PartOrigin = "fpt" | "ieee"

/** Nhãn báo cáo họ mẫu (FLF-363) — tính sau khi khớp theo nguồn của tên đã khớp, không quyết định cách khớp. */
export const TEMPLATE_FAMILIES = ["fpt", "ieee29148", "mixed"] as const
export type TemplateFamily = (typeof TEMPLATE_FAMILIES)[number]

/** Bản ghi cũ (FLF-252) lưu họ mẫu IEEE 830 / System Features ⇒ cùng là mẫu IEEE. */
export const normalizeTemplateFamily = (value: string | null | undefined): TemplateFamily =>
  value === "ieee830" || value === "ieee_features" ? "ieee29148" : (TEMPLATE_FAMILIES as readonly string[]).includes(value ?? "") ? (value as TemplateFamily) : "fpt"

export interface PartTitle {
  text: string
  origin: PartOrigin
}

export interface PartDef {
  /** `part:fixed:2.1`, `part:ieee:references` — nội bộ, không hiện cho người dùng. */
  id: string
  target: string
  titles: readonly PartTitle[]
  parents?: readonly string[]
  repeat?: boolean
  features?: boolean
  underFeature?: boolean
}

interface IeeeSeed {
  target: string
  titles: string[]
  id?: string
  parents?: string[]
  repeat?: boolean
  features?: boolean
  underFeature?: boolean
}

const REVISION_TITLES = ["Revision History", "Record of Changes", "Document History", "Change History", "Version History", "Lịch sử thay đổi", "Lịch sử phiên bản", "Lịch sử sửa đổi"]

/**
 * Tên FPT bị ngân hàng lấy sang phần khác (quyết định plan §6): "Product Functions" là sơ đồ use case, không phải tổng quan
 * chức năng 3.1; "Specific Requirements" là chương yêu cầu chung (gồm cả phi chức năng), không phải chương chức năng.
 */
const MOVED_FPT_TITLES: Readonly<Record<string, readonly string[]>> = {
  "group:3.1": ["Product Functions", "Chức năng sản phẩm"],
  "group:3": ["Specific Requirements", "Yêu cầu cụ thể"]
}

/** Tên của mẫu IEEE mới (jam01 / 29148 + IEEE 830, Wiegers, ReqView) theo phần — nguồn: plan §2.5. */
const IEEE_SEEDS: readonly IeeeSeed[] = [
  { target: "fixed:I", titles: REVISION_TITLES },
  {
    target: "fixed:1",
    repeat: true,
    titles: [
      "Introduction", "Giới thiệu", "Purpose", "Document Purpose", "Mục đích", "Mục đích tài liệu", "Scope", "Product Scope", "Project Scope",
      "Phạm vi", "Phạm vi sản phẩm", "Product Perspective", "Góc nhìn sản phẩm", "Bối cảnh sản phẩm", "Overall Description", "Mô tả tổng quan",
      "Mô tả chung", "Product Overview", "Tổng quan sản phẩm"
    ]
  },
  { target: "fixed:2.1", titles: ["User Characteristics", "User Classes and Characteristics", "Đặc điểm người dùng"] },
  { target: "fixed:2.2.1", titles: ["Product Functions", "Product Features", "Chức năng sản phẩm"] },
  { target: "fixed:3.1.2", repeat: true, titles: ["User Interfaces", "User Interface", "Giao diện người dùng", "UI Mockups", "Mockups", "Mockup giao diện"] },
  {
    target: "fixed:3.1.5",
    repeat: true,
    titles: [
      "Logical Database Requirements", "Logical Database", "Data Model", "Data / Class Model", "Class Model", "Class Diagram", "Entity Relationship Diagram",
      "Entities and Relationships", "Data Dictionary", "Yêu cầu cơ sở dữ liệu logic", "Mô hình dữ liệu", "Thực thể và quan hệ", "Từ điển dữ liệu"
    ]
  },
  {
    target: "fixed:4.1",
    repeat: true,
    titles: [
      "External Interfaces", "External Interface Requirements", "System Interfaces", "Hardware Interfaces", "Software Interfaces", "Communications Interfaces",
      "Communication Interfaces", "Interfaces with Services", "Giao diện bên ngoài", "Giao diện ngoài", "Giao diện hệ thống", "Giao diện phần cứng",
      "Giao diện phần mềm", "Giao diện truyền thông"
    ]
  },
  { target: "fixed:4.2.1", titles: ["Usability", "Usability Requirements", "Khả năng sử dụng", "Tính khả dụng"] },
  { target: "fixed:4.2.2", repeat: true, titles: ["Reliability", "Availability", "Độ tin cậy", "Tính sẵn sàng"] },
  { target: "fixed:4.2.3", titles: ["Performance", "Performance Requirements", "Hiệu năng"] },
  {
    target: "fixed:4.2.4",
    repeat: true,
    titles: [
      "Constraints", "General Constraints", "Design Constraints", "Design and Implementation Constraints", "Product Constraints", "Limitations",
      "Memory Constraints", "Security", "Security Requirements", "Safety", "Safety Requirements", "Maintainability", "Portability", "Reusability",
      "Observability", "Operating Environment", "Môi trường vận hành", "Ràng buộc", "Ràng buộc thiết kế", "Ràng buộc sản phẩm", "Giới hạn", "Ràng buộc bộ nhớ", "Bảo mật", "An toàn",
      "Khả năng bảo trì", "Tính khả chuyển", "Khả năng chuyển đổi", "Khả năng tái sử dụng", "Khả năng quan sát"
    ]
  },
  { target: "group:4.2", titles: ["Software System Attributes", "Quality of Service", "Quality Requirements", "Yêu cầu chất lượng", "Software Quality Attributes", "Thuộc tính hệ thống phần mềm", "Chất lượng dịch vụ"] },
  { target: "group:4", titles: ["Other Nonfunctional Requirements", "Nonfunctional Requirements", "Yêu cầu phi chức năng khác"] },
  { target: "group:3", titles: ["Functions", "Functional", "Functional Requirements", "System Features", "Chức năng", "Yêu cầu chức năng", "Tính năng hệ thống"] },
  { target: "fixed:5.1", titles: ["Business Rules", "Integrity Constraints", "Ràng buộc toàn vẹn"] },
  {
    target: "fixed:5.4",
    repeat: true,
    titles: [
      "Assumptions and Dependencies", "Giả định và phụ thuộc", "Other Requirements", "Yêu cầu khác", "Standards Compliance", "Compliance", "Tuân thủ",
      "Tuân thủ tiêu chuẩn", "Supporting Information", "Thông tin hỗ trợ", "Operations", "Vận hành", "Site Adaptation Requirements", "Yêu cầu thích ứng",
      "User Documentation", "Tài liệu người dùng", "Installation", "Cài đặt", "Build and Delivery", "Build và phát hành", "Distribution", "Phân tán",
      "Cost", "Chi phí", "Deadline", "Thời hạn", "Proof of Concept", "Thử nghiệm khái niệm", "Change Management", "Quản lý thay đổi", "AI/ML",
      "Data Retention", "Lưu giữ dữ liệu", "Frequency of Use and Access", "Tần suất và cách truy cập"
    ]
  },
  {
    target: "fixed:5.5",
    repeat: true,
    titles: [
      "Definitions, Acronyms and Abbreviations", "Definitions, Acronyms, and Abbreviations", "Definitions, Acronyms & Abbreviations", "Definitions",
      "Acronyms and Abbreviations", "Glossary", "Appendix A: Glossary", "Định nghĩa, từ viết tắt", "Định nghĩa và từ viết tắt", "Thuật ngữ", "Từ viết tắt"
    ]
  },
  { target: "group:5", titles: ["Appendixes", "Appendices", "Appendix", "Phụ lục"] },
  // Chỉ có ở IEEE — giữ nguyên văn
  { id: "part:ieee:references", target: "keep", titles: ["References", "Tài liệu tham khảo"] },
  { id: "part:ieee:doc_overview", target: "keep", titles: ["Document Overview", "Tổng quan tài liệu"] },
  // "Overview" dưới Introduction là tổng quan tài liệu (IEEE 830 §1.5); đứng riêng là tổng quan sản phẩm (FPT)
  { id: "part:ieee:doc_overview_in_intro", target: "keep", titles: ["Overview"], parents: ["part:fixed:1"] },
  { id: "part:ieee:conventions", target: "keep", titles: ["Document Conventions", "Quy ước tài liệu"] },
  { id: "part:ieee:audience", target: "keep", titles: ["Intended Audience and Reading Suggestions", "Intended Audience", "Đối tượng đọc"] },
  { id: "part:ieee:apportioning", target: "keep", titles: ["Apportioning of Requirements", "Phân bổ yêu cầu"] },
  { id: "part:ieee:requirements", target: "keep", titles: ["Requirements", "Specific Requirements", "Yêu cầu", "Yêu cầu cụ thể"] },
  // IEEE 830 rút gọn: "3.2 Specific requirements" nằm trong "3 Specific Requirements" là một tính năng (mục con là chức năng);
  // chứa mục "Classes for classification" thì chỉ là heading
  { id: "part:ieee:specific_feature", target: "feature", titles: ["Specific Requirements", "Yêu cầu cụ thể"], parents: ["part:ieee:requirements"] },
  { id: "part:ieee:design_impl", target: "keep", titles: ["Design and Implementation", "Thiết kế và triển khai"] },
  { id: "part:ieee:verification", target: "keep", titles: ["Verification", "Kiểm chứng"] },
  // Tên tài liệu dùng làm heading (FPT "II. Software Requirement Specification") — chỉ là heading, giữ nguyên văn
  {
    id: "part:doc_title",
    target: "keep",
    titles: ["Software Requirement Specification", "Software Requirements Specification", "Đặc tả yêu cầu phần mềm", "Tài liệu đặc tả yêu cầu phần mềm"]
  },
  { id: "part:ieee:toc", target: "keep", titles: ["Table of Contents and Index", "Mục lục"] },
  { id: "part:ieee:analysis_models", target: "keep", titles: ["Appendix B: Analysis Models", "Analysis Models", "Mô hình phân tích"] },
  { id: "part:ieee:tbd_list", target: "keep", titles: ["Appendix C: To Be Determined List", "To Be Determined List", "Danh sách cần xác định"] },
  // Spine chưa có loại sơ đồ này ⇒ giữ nguyên văn (ảnh gốc)
  { id: "part:ieee:sequence", target: "keep", titles: ["Sequence Diagrams", "Sequence Diagram", "Biểu đồ tuần tự", "Sơ đồ tuần tự"] },
  // IEEE 830 §5.3.2: cách chia yêu cầu chức năng — mục con là tính năng
  {
    id: "part:ieee:classes",
    target: "keep",
    features: true,
    titles: ["Classes for Classification of Specific Requirements", "Classes for Classification", "Organizing the Specific Requirements"]
  },
  // Mục mô tả chính tính năng cha (Wiegers): nội dung thuộc tính năng
  {
    id: "part:ieee:feature_detail",
    target: "parent",
    underFeature: true,
    repeat: true,
    titles: [
      "Description and Priority", "Description", "Mô tả và độ ưu tiên", "Stimulus/Response Sequences", "Stimulus / Response Sequences",
      "Chuỗi kích thích / phản hồi", "Functional Requirements", "Yêu cầu chức năng"
    ]
  }
]

/** Tên quá chung — vẫn khớp heading, nhưng không là dấu hiệu "tài liệu này là SRS". */
const WEAK_TITLES = new Set(
  [
    "Requirements", "Yêu cầu", "Functions", "Functional", "Chức năng", "Verification", "Kiểm chứng", "Cost", "Chi phí", "Deadline", "Thời hạn",
    "Installation", "Cài đặt", "Distribution", "Phân tán", "Compliance", "Tuân thủ", "Operations", "Vận hành", "Description", "Overview",
    "Constraints", "Ràng buộc", "Limitations", "Giới hạn", "Safety", "An toàn", "Appendix", "Phụ lục", "Scope", "Phạm vi", "Purpose", "Mục đích"
  ].map((t) => t.toLowerCase())
)

export const isWeakTitle = (title: string): boolean => WEAK_TITLES.has(title.trim().toLowerCase())

const buildBank = (): PartDef[] => {
  const parts = new Map<string, PartDef>()
  for (const c of SECTION_CANDIDATES) {
    const moved = new Set(MOVED_FPT_TITLES[c.id] ?? [])
    const titles = [...new Map(c.titles.filter((t) => !moved.has(t)).map((t) => [t.toLowerCase(), t])).values()]
    parts.set(`part:${c.id}`, { id: `part:${c.id}`, target: c.id, titles: titles.map((text) => ({ text, origin: "fpt" as const })) })
  }
  for (const seed of IEEE_SEEDS) {
    const id = seed.id ?? `part:${seed.target}`
    const existing = parts.get(id)
    const known = new Set((existing?.titles ?? []).map((t) => t.text.toLowerCase()))
    const added = seed.titles.filter((t) => !known.has(t.toLowerCase())).map((text) => ({ text, origin: "ieee" as const }))
    parts.set(id, {
      ...(existing ?? { id, target: seed.target, titles: [] }),
      titles: [...(existing?.titles ?? []), ...added],
      ...(seed.parents ? { parents: seed.parents } : {}),
      ...(seed.repeat ? { repeat: true } : {}),
      ...(seed.features ? { features: true } : {}),
      ...(seed.underFeature ? { underFeature: true } : {})
    })
  }
  // Chương chức năng: mục con không khớp là tính năng (như chương 3 của FPT)
  const functional = parts.get("part:group:3")
  if (functional) parts.set(functional.id, { ...functional, features: true })
  return [...parts.values()]
}

export const PART_BANK: readonly PartDef[] = Object.freeze(buildBank())

export const partById = (id: string): PartDef | undefined => PART_BANK.find((p) => p.id === id)

const fold = (t: string) => t.trim().toLowerCase()
const FPT_TITLES = new Set(SECTION_CANDIDATES.flatMap((c) => c.titles.map(fold)))
const FPT_CANONICAL = new Set(SECTION_CANDIDATES.map((c) => fold(c.titles[0])))
const IEEE_TITLES = new Set(IEEE_SEEDS.flatMap((s) => s.titles.map(fold)))

/**
 * Mẫu có tên này. Tên khác của FPT lấy từ IEEE (FLF-183: Purpose, Scope, User Characteristics…) tính là IEEE; tên chuẩn FPT
 * mà IEEE cũng dùng (Performance, Glossary…) tính cả hai.
 */
export const titleOrigins = (title: string): PartOrigin[] => {
  const k = fold(title)
  if (IEEE_TITLES.has(k)) return FPT_CANONICAL.has(k) ? ["fpt", "ieee"] : ["ieee"]
  return FPT_TITLES.has(k) ? ["fpt"] : []
}
