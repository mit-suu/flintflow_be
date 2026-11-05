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
 * - `slot`: phần nhỏ Spine ưu tiên (plan §2.5: Purpose ⇒ `slot:vision`…) — dùng khi file không có heading nào khác nhận mục FPT
 *   cha của phần nhỏ đó (một phần dữ liệu chỉ in một lần, `slotOverlaps`), không thì về `target` (chính mục cha).
 * - `repeat`: mẫu thật có nhiều heading cùng nghĩa (Reliability + Availability, các loại giao diện…) ⇒ phần nhận nhiều
 *   heading; còn lại mỗi phần tối đa một heading (như danh mục cũ).
 * - `parents`: phần cha hợp lệ — tách tên trùng ở hai chỗ ("Overview" dưới Introduction = tổng quan tài liệu).
 * - `features`: mục con không khớp là tính năng (chương chức năng). `underFeature`: chỉ khớp khi nằm dưới một tính năng.
 * - Tên `weak` (quá chung: "Cost", "Requirements"…) vẫn khớp, nhưng không tính là dấu hiệu "là SRS" (`srs-detect.ts`).
 */

import { SECTION_CANDIDATES } from "./section-catalog.js"
import { foldText, foldTokens, splitHeadingNumber, titleSimilarity } from "./text-similarity.js"

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
  slot?: string
  repeat?: boolean
  features?: boolean
  underFeature?: boolean
}

interface IeeeSeed {
  target: string
  titles: string[]
  id?: string
  slot?: string
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
  "group:3": ["Specific Requirements", "Yêu cầu cụ thể"],
  // Mục con của tổng quan / yêu cầu khác có phần nhỏ riêng (phần `slot` bên dưới)
  "fixed:1": ["Purpose", "Mục đích", "Scope", "Product Scope", "Phạm vi", "Product Perspective"],
  "fixed:5.4": ["Assumptions and Dependencies", "Giả định và phụ thuộc"]
}

/** Tên của mẫu IEEE mới (jam01 / 29148 + IEEE 830, Wiegers, ReqView) theo phần — nguồn: plan §2.5. */
const IEEE_SEEDS: readonly IeeeSeed[] = [
  { target: "fixed:I", titles: REVISION_TITLES },
  {
    target: "fixed:1",
    repeat: true,
    titles: ["Introduction", "Giới thiệu", "Overall Description", "Mô tả tổng quan", "Mô tả chung", "Product Overview", "Tổng quan sản phẩm"]
  },
  { id: "part:ieee:purpose", target: "fixed:1", slot: "slot:vision", titles: ["Purpose", "Document Purpose", "Mục đích", "Mục đích tài liệu"] },
  {
    id: "part:ieee:scope",
    target: "fixed:1",
    slot: "slot:scope",
    titles: ["Scope", "Product Scope", "Project Scope", "Phạm vi", "Phạm vi sản phẩm"]
  },
  { id: "part:ieee:perspective", target: "fixed:1", slot: "slot:context", titles: ["Product Perspective", "Góc nhìn sản phẩm", "Bối cảnh sản phẩm"] },
  { id: "part:ieee:platforms", target: "slot:platforms", titles: ["Operating Environment", "Môi trường vận hành"] },
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
      "Observability", "Ràng buộc", "Ràng buộc thiết kế", "Ràng buộc sản phẩm", "Giới hạn", "Ràng buộc bộ nhớ", "Bảo mật", "An toàn",
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
      "Other Requirements", "Yêu cầu khác", "Standards Compliance", "Compliance", "Tuân thủ", "Design and Implementation", "Thiết kế và triển khai",
      "Tuân thủ tiêu chuẩn", "Supporting Information", "Thông tin hỗ trợ", "Operations", "Vận hành", "Site Adaptation Requirements", "Yêu cầu thích ứng",
      "User Documentation", "Tài liệu người dùng", "Installation", "Cài đặt", "Build and Delivery", "Build và phát hành", "Distribution", "Phân tán",
      "Cost", "Chi phí", "Deadline", "Thời hạn", "Proof of Concept", "Thử nghiệm khái niệm", "Change Management", "Quản lý thay đổi", "AI/ML",
      "Data Retention", "Lưu giữ dữ liệu", "Frequency of Use and Access", "Tần suất và cách truy cập"
    ]
  },
  {
    id: "part:ieee:assumptions",
    target: "fixed:5.4",
    slot: "slot:assumptions",
    titles: ["Assumptions and Dependencies", "Assumptions", "Giả định và phụ thuộc", "Giả định"]
  },
  {
    id: "part:ieee:tbd_list",
    target: "fixed:5.4",
    slot: "slot:open_questions",
    titles: ["Appendix C: To Be Determined List", "To Be Determined List", "Danh sách cần xác định"]
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
  // FLF-365: References / Apportioning / Verification có chỗ riêng trong Spine (phần nhỏ, không mục FPT cha)
  { id: "part:ieee:references", target: "slot:references", titles: ["References", "Tài liệu tham khảo"] },
  { id: "part:ieee:doc_overview", target: "keep", titles: ["Document Overview", "Tổng quan tài liệu"] },
  // "Overview" dưới Introduction là tổng quan tài liệu (IEEE 830 §1.5); đứng riêng là tổng quan sản phẩm (FPT)
  { id: "part:ieee:doc_overview_in_intro", target: "keep", titles: ["Overview"], parents: ["part:fixed:1"] },
  { id: "part:ieee:conventions", target: "keep", titles: ["Document Conventions", "Quy ước tài liệu"] },
  { id: "part:ieee:audience", target: "keep", titles: ["Intended Audience and Reading Suggestions", "Intended Audience", "Đối tượng đọc"] },
  { id: "part:ieee:apportioning", target: "slot:apportioning", titles: ["Apportioning of Requirements", "Phân bổ yêu cầu"] },
  { id: "part:ieee:requirements", target: "keep", titles: ["Requirements", "Specific Requirements", "Yêu cầu", "Yêu cầu cụ thể"] },
  // IEEE 830: "3.2 Functional Requirements" / "3.2 Specific requirements" (rút gọn) nằm trong "3 Specific Requirements" là một
  // tính năng — bảng FR ngay dưới thành chức năng của nó; chứa mục "Classes for classification" thì chỉ là heading
  {
    id: "part:ieee:specific_feature",
    target: "feature",
    titles: ["Specific Requirements", "Yêu cầu cụ thể", "Functional Requirements", "Yêu cầu chức năng"],
    parents: ["part:ieee:requirements"]
  },
  { id: "part:ieee:verification", target: "slot:verification", titles: ["Verification", "Kiểm chứng"] },
  // Tên tài liệu dùng làm heading (FPT "II. Software Requirement Specification") — chỉ là heading, giữ nguyên văn
  {
    id: "part:doc_title",
    target: "keep",
    titles: ["Software Requirement Specification", "Software Requirements Specification", "Đặc tả yêu cầu phần mềm", "Tài liệu đặc tả yêu cầu phần mềm"]
  },
  { id: "part:ieee:toc", target: "keep", titles: ["Table of Contents and Index", "Mục lục"] },
  { id: "part:ieee:analysis_models", target: "keep", titles: ["Appendix B: Analysis Models", "Analysis Models", "Mô hình phân tích"] },
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
      ...(seed.slot ? { slot: seed.slot } : {}),
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

/**
 * Skill nội dung sinh / bổ sung đúng phần (plan §2.4, cột "Skill sinh") — cho mục giữ nguyên văn của file (`custom:*`, không
 * có step sở hữu) mà heading khớp một phần của ngân hàng. Theo đích; phần chỉ có ở IEEE theo id. FLF-365: References,
 * Apportioning, Verification có skill riêng.
 */
const SKILL_BY_TARGET: readonly [RegExp, string][] = [
  [/^slot:references$/, "references-list"],
  [/^slot:apportioning$/, "requirement-apportioning"],
  [/^slot:verification$/, "verification-matrix"],
  [/^(fixed:1|slot:(vision|goals|scope|context|platforms))$/, "product-overview"],
  [/^slot:high_rules$/, "high-level-rules"],
  [/^(fixed:2\.|group:2)/, "actors-and-usecases"],
  [/^fixed:3\.1\.[12]$|^group:3\.1$/, "screens-and-flow"],
  [/^fixed:3\.1\.3$/, "authorization-matrix"],
  [/^fixed:3\.1\.4$/, "non-screen-functions"],
  [/^fixed:3\.1\.5$/, "entities-erd"],
  [/^(fixed:4\.|group:4)/, "nfr-quality-attributes"],
  [/^fixed:5\.5$/, "glossary"],
  [/^(fixed:5\.[1-4]|group:5|slot:(assumptions|risks|open_questions|security|localization))$/, "appendix-content"]
]
const SKILL_BY_PART: Readonly<Record<string, string>> = {
  "part:ieee:doc_overview": "product-overview",
  "part:ieee:doc_overview_in_intro": "product-overview",
  "part:ieee:conventions": "product-overview",
  "part:ieee:audience": "product-overview",
  "part:ieee:sequence": "actors-and-usecases",
  "part:ieee:specific_feature": "function-detail",
  "part:ieee:classes": "function-detail",
  "part:ieee:feature_detail": "function-detail"
}

/**
 * FLF-364: nội dung mục nên có theo ISO 29148 (plan §2.4, cột "Nội dung nên có") — ngữ cảnh cho AI khi soạn / bổ sung mục của
 * mẫu upload. Theo đích của phần.
 */
const EXPECTED_CONTENT: readonly [RegExp, string][] = [
  [/^slot:vision$/, "purpose of the software / document and its intended readers"],
  [/^slot:scope$/, "product name, what it does and does not do, benefits, goals"],
  [/^slot:context$/, "context and relation to other systems (block / context diagram, external system names)"],
  [/^slot:platforms$/, "operating environment: hardware, OS, platforms the product runs on"],
  [/^fixed:1$/, "product overview: purpose, scope, context, high-level goals"],
  [/^fixed:2\.1$/, "user groups / actors: skills, experience, expertise, accessibility needs"],
  [/^fixed:2\.2\.1$/, "summary of the main functions and their relations (use case diagram)"],
  [/^fixed:3\.1\.2$/, "logical characteristics of each screen: layout, menus, shortcuts, mockups"],
  [/^fixed:3\.1\.5$/, "information types, frequency of use, access, entities and relations, integrity constraints, retention"],
  [/^fixed:4\.1$/, "each input / output: name, source, destination, valid range, unit, format, timing; protocols and versions"],
  [/^fixed:4\.2\.1$/, "measurable usability criteria: effectiveness, efficiency, satisfaction"],
  [/^fixed:4\.2\.2$/, "reliability / availability with numbers (MTBF, uptime %, RTO / RPO)"],
  [/^fixed:4\.2\.3$/, "static and dynamic numeric requirements: users, data volume, transactions per time unit"],
  [/^fixed:4\.2\.4$/, "constraints and attributes: standards, technology, security, maintainability, portability"],
  [/^(fixed:5\.4|slot:(assumptions|open_questions))$/, "assumptions, dependencies, compliance, operations, supporting information"],
  [/^fixed:5\.5$/, "terms, acronyms and abbreviations with definitions"]
]

export const expectedContentOf = (sectionId: string): string | null => EXPECTED_CONTENT.find(([re]) => re.test(sectionId))?.[1] ?? null

/** Skill theo mục (phần nhỏ / mục FPT) — vị trí CR ở phần nhỏ không có step sở hữu (FLF-365: `slot:references`…). */
export const skillOfSection = (sectionId: string): string | null => SKILL_BY_TARGET.find(([re]) => re.test(sectionId))?.[1] ?? null

export const skillOfPart = (part: PartDef): string | null =>
  SKILL_BY_PART[part.id] ?? SKILL_BY_TARGET.find(([re]) => re.test(part.slot ?? part.target))?.[1] ?? null

/** Phần của ngân hàng mà một heading khớp chắc theo tên (bỏ số mục) — không xét mục cha; không chắc ⇒ `null`. */
export const partOfHeading = (heading: string): PartDef | null => {
  const title = splitHeadingNumber(heading).title
  let best: { part: PartDef; score: number } | null = null
  for (const part of PART_BANK) {
    if (part.parents) continue
    const score = Math.max(0, ...part.titles.map((t) => titleSimilarity(title, t.text)))
    if (score >= 0.8 && (!best || score > best.score)) best = { part, score }
  }
  return best?.part ?? null
}

/** Tên phần đủ riêng để nhận trong câu hướng dẫn: ≥ 2 từ, không phải tên quá chung (khởi tạo khi gọi lần đầu). */
let guidanceTitles: readonly { part: PartDef; title: string }[] | null = null

/**
 * FLF-364: các phần mà chữ hướng dẫn của mẫu nhắc tên ("[List all documents referenced…]" ⇒ References) — dùng nhận phần cho
 * heading không khớp tên (I-3) và chọn skill cho mục giữ nguyên văn (C-4). Chỉ tin khi đúng một phần.
 */
export const partsMentionedIn = (text: string): PartDef[] => {
  guidanceTitles ??= PART_BANK.filter((p) => !p.underFeature && !p.parents).flatMap((part) =>
    part.titles.filter((t) => !isWeakTitle(t.text) && foldTokens(t.text).length >= 2).map((t) => ({ part, title: ` ${foldText(t.text)} ` }))
  )
  const folded = ` ${foldText(text)} `
  return [...new Map(guidanceTitles.filter((t) => folded.includes(t.title)).map((t) => [t.part.id, t.part])).values()]
}

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
