/**
 * Danh mục mục của các mẫu SRS ngoài FPT (FLF-252) — dùng để khớp heading của file IEEE rồi trích vào section FPT của
 * Spine. Hàm thuần / dữ liệu tĩnh. Mẫu FPT vẫn khớp theo `section-catalog.ts` (registry đóng băng).
 *
 * Đích (`target`) của một mục:
 * - section FPT (`fixed:*` / `group:*`) — nội dung trích vào section đó; nhiều mục IEEE có thể cùng một section FPT
 *   (Reliability + Availability ⇒ 4.2.2);
 * - `keep` — mục chỉ có ở mẫu IEEE (References, Overview…): giữ nguyên văn, không trích;
 * - `feature` — mục là một tính năng (chương yêu cầu chức năng IEEE 830): mục con thành chức năng, chữ / bảng ngay dưới trích
 *   thành chức năng của tính năng đó;
 * - `parent` — mục con mô tả chính mục cha (Wiegers "Description and Priority", "Functional Requirements" dưới một tính năng):
 *   nội dung thuộc section của mục cha.
 * `features: true` — mục con không khớp danh mục là tính năng (như chương 3 của FPT).
 */

export type TemplateFamily = "fpt" | "ieee830" | "ieee_features"

export type TemplateTarget = string

export interface TemplateEntry {
  /** `ieee830:3.5.2` — chỉ dùng nội bộ, không hiện cho người dùng. */
  id: string
  /** Số mục theo mẫu ("" = mục không đánh số, vd Revision History). */
  number: string
  titles: readonly string[]
  target: TemplateTarget
  features?: boolean
}

const e = (family: TemplateFamily, number: string, target: TemplateTarget, titles: string[], extra: Partial<TemplateEntry> = {}): TemplateEntry => ({
  id: `${family}:${number || titles[0].toLowerCase().replace(/\W+/g, "_")}`,
  number,
  titles,
  target,
  ...extra
})

const REVISION_TITLES = ["Revision History", "Record of Changes", "Document History", "Change History", "Version History", "Lịch sử thay đổi", "Lịch sử phiên bản"]

/** IEEE 830 (mẫu rút gọn trong `doc/IEEE_830_SRS_Concise_Template.docx` + biến thể hay gặp). */
export const IEEE_830: readonly TemplateEntry[] = [
  e("ieee830", "", "fixed:I", REVISION_TITLES),
  e("ieee830", "1", "fixed:1", ["Introduction", "Giới thiệu"]),
  e("ieee830", "1.1", "fixed:1", ["Purpose", "Mục đích"]),
  e("ieee830", "1.2", "fixed:1", ["Scope", "Product Scope", "Phạm vi", "Phạm vi sản phẩm"]),
  e("ieee830", "1.3", "fixed:5.5", ["Definitions, Acronyms and Abbreviations", "Definitions, Acronyms & Abbreviations", "Definitions", "Glossary", "Thuật ngữ", "Định nghĩa và từ viết tắt"]),
  e("ieee830", "1.4", "keep", ["References", "Tài liệu tham khảo"]),
  e("ieee830", "1.5", "keep", ["Overview", "Document Overview", "Tổng quan tài liệu"]),
  e("ieee830", "2", "keep", ["Overall Description", "Mô tả tổng quan", "Mô tả chung"]),
  e("ieee830", "2.1", "fixed:1", ["Product Perspective", "Bối cảnh sản phẩm", "Góc nhìn sản phẩm"]),
  e("ieee830", "2.1.1", "fixed:4.1", ["System Interfaces", "Giao diện hệ thống"]),
  e("ieee830", "2.1.2", "fixed:3.1.2", ["User Interfaces", "Giao diện người dùng"]),
  e("ieee830", "2.1.3", "fixed:4.1", ["Hardware Interfaces", "Giao diện phần cứng"]),
  e("ieee830", "2.1.4", "fixed:4.1", ["Software Interfaces", "Giao diện phần mềm"]),
  e("ieee830", "2.1.5", "fixed:4.1", ["Communications Interfaces", "Communication Interfaces", "Giao diện truyền thông"]),
  e("ieee830", "2.1.6", "fixed:4.2.4", ["Memory Constraints", "Ràng buộc bộ nhớ"]),
  e("ieee830", "2.1.7", "fixed:5.4", ["Operations", "Vận hành"]),
  e("ieee830", "2.1.8", "fixed:5.4", ["Site Adaptation Requirements", "Yêu cầu thích ứng"]),
  e("ieee830", "2.2", "keep", ["Product Functions", "Chức năng sản phẩm"]),
  e("ieee830", "2.3", "fixed:2.1", ["User Characteristics", "User Classes and Characteristics", "Đặc điểm người dùng"]),
  e("ieee830", "2.4", "fixed:4.2.4", ["Constraints", "General Constraints", "Ràng buộc"]),
  e("ieee830", "2.5", "fixed:5.4", ["Assumptions and Dependencies", "Giả định và phụ thuộc"]),
  e("ieee830", "2.6", "keep", ["Apportioning of Requirements", "Phân bổ yêu cầu"]),
  e("ieee830", "3", "group:3", ["Specific Requirements", "Yêu cầu cụ thể"]),
  e("ieee830", "3.1", "fixed:4.1", ["External Interface Requirements", "External Interfaces", "Yêu cầu giao diện ngoài"]),
  e("ieee830", "3.1.1", "fixed:3.1.2", ["User Interfaces", "Giao diện người dùng"]),
  e("ieee830", "3.1.2", "fixed:4.1", ["Hardware Interfaces", "Giao diện phần cứng"]),
  e("ieee830", "3.1.3", "fixed:4.1", ["Software Interfaces", "Giao diện phần mềm"]),
  e("ieee830", "3.1.4", "fixed:4.1", ["Communications Interfaces", "Communication Interfaces", "Giao diện truyền thông"]),
  e("ieee830", "3.2", "feature", ["Functional Requirements", "Specific Requirements", "System Features", "Yêu cầu chức năng"]),
  e("ieee830", "3.2.1", "fixed:2.2.2", ["Use Cases / Sequence Diagrams", "Use Cases", "Sequence Diagrams", "Use Case Descriptions", "Ca sử dụng"]),
  e("ieee830", "3.2.2", "fixed:3.1.5", ["Classes for Classification of Specific Requirements", "Data / Class Model", "Class Model", "Data Model", "Class Diagram", "Mô hình dữ liệu"]),
  e("ieee830", "3.3", "fixed:4.2.3", ["Performance Requirements", "Yêu cầu hiệu năng"]),
  e("ieee830", "3.4", "fixed:4.2.4", ["Design Constraints", "Ràng buộc thiết kế"]),
  e("ieee830", "3.5", "group:4.2", ["Software System Attributes", "Thuộc tính hệ thống phần mềm"]),
  e("ieee830", "3.5.1", "fixed:4.2.2", ["Reliability", "Độ tin cậy"]),
  e("ieee830", "3.5.2", "fixed:4.2.2", ["Availability", "Tính sẵn sàng"]),
  e("ieee830", "3.5.3", "fixed:4.2.4", ["Security", "Bảo mật"]),
  e("ieee830", "3.5.4", "fixed:4.2.4", ["Maintainability", "Khả năng bảo trì"]),
  e("ieee830", "3.5.5", "fixed:4.2.4", ["Portability", "Tính khả chuyển"]),
  e("ieee830", "", "fixed:4.2.1", ["Usability", "Tính khả dụng"]),
  e("ieee830", "3.6", "fixed:5.4", ["Other Requirements", "Yêu cầu khác"]),
  e("ieee830", "4", "keep", ["Supporting Information", "Thông tin hỗ trợ"]),
  e("ieee830", "4.1", "keep", ["Table of Contents and Index", "Mục lục"]),
  e("ieee830", "4.2", "keep", ["Appendixes", "Appendices", "Appendix", "Phụ lục"])
]

/** Mẫu SRS dạng "System Features" (Wiegers / IEEE 830 phiên bản phổ biến): chương 4 là danh sách tính năng. */
export const IEEE_FEATURES: readonly TemplateEntry[] = [
  e("ieee_features", "", "fixed:I", REVISION_TITLES),
  e("ieee_features", "1", "fixed:1", ["Introduction", "Giới thiệu"]),
  e("ieee_features", "1.1", "fixed:1", ["Purpose", "Mục đích"]),
  e("ieee_features", "1.2", "keep", ["Document Conventions", "Quy ước tài liệu"]),
  e("ieee_features", "1.3", "keep", ["Intended Audience and Reading Suggestions", "Intended Audience", "Đối tượng đọc"]),
  e("ieee_features", "1.4", "fixed:1", ["Product Scope", "Project Scope", "Scope", "Phạm vi sản phẩm"]),
  e("ieee_features", "1.5", "keep", ["References", "Tài liệu tham khảo"]),
  e("ieee_features", "2", "keep", ["Overall Description", "Mô tả tổng quan"]),
  e("ieee_features", "2.1", "fixed:1", ["Product Perspective", "Bối cảnh sản phẩm"]),
  e("ieee_features", "2.2", "keep", ["Product Functions", "Product Features", "Chức năng sản phẩm"]),
  e("ieee_features", "2.3", "fixed:2.1", ["User Classes and Characteristics", "User Characteristics", "Đặc điểm người dùng"]),
  e("ieee_features", "2.4", "fixed:4.2.4", ["Operating Environment", "Môi trường vận hành"]),
  e("ieee_features", "2.5", "fixed:4.2.4", ["Design and Implementation Constraints", "Constraints", "Ràng buộc thiết kế và cài đặt"]),
  e("ieee_features", "2.6", "fixed:5.4", ["User Documentation", "Tài liệu người dùng"]),
  e("ieee_features", "2.7", "fixed:5.4", ["Assumptions and Dependencies", "Giả định và phụ thuộc"]),
  e("ieee_features", "3", "fixed:4.1", ["External Interface Requirements", "Yêu cầu giao diện ngoài"]),
  e("ieee_features", "3.1", "fixed:3.1.2", ["User Interfaces", "Giao diện người dùng"]),
  e("ieee_features", "3.2", "fixed:4.1", ["Hardware Interfaces", "Giao diện phần cứng"]),
  e("ieee_features", "3.3", "fixed:4.1", ["Software Interfaces", "Giao diện phần mềm"]),
  e("ieee_features", "3.4", "fixed:4.1", ["Communications Interfaces", "Communication Interfaces", "Giao diện truyền thông"]),
  e("ieee_features", "4", "group:3", ["System Features", "Functional Requirements", "Tính năng hệ thống"], { features: true }),
  e("ieee_features", "", "parent", ["Description and Priority", "Description", "Mô tả và độ ưu tiên"]),
  e("ieee_features", "", "parent", ["Stimulus/Response Sequences", "Stimulus / Response Sequences", "Chuỗi kích thích / phản hồi"]),
  e("ieee_features", "", "parent", ["Functional Requirements", "Yêu cầu chức năng"]),
  e("ieee_features", "5", "group:4", ["Other Nonfunctional Requirements", "Nonfunctional Requirements", "Yêu cầu phi chức năng"]),
  e("ieee_features", "5.1", "fixed:4.2.3", ["Performance Requirements", "Yêu cầu hiệu năng"]),
  e("ieee_features", "5.2", "fixed:4.2.2", ["Safety Requirements", "Yêu cầu an toàn"]),
  e("ieee_features", "5.3", "fixed:4.2.4", ["Security Requirements", "Yêu cầu bảo mật"]),
  e("ieee_features", "5.4", "fixed:4.2.1", ["Software Quality Attributes", "Thuộc tính chất lượng"]),
  e("ieee_features", "5.5", "fixed:5.1", ["Business Rules", "Quy tắc nghiệp vụ"]),
  e("ieee_features", "6", "fixed:5.4", ["Other Requirements", "Yêu cầu khác"]),
  e("ieee_features", "", "fixed:5.5", ["Appendix A: Glossary", "Glossary", "Thuật ngữ"]),
  e("ieee_features", "", "keep", ["Appendix B: Analysis Models", "Analysis Models", "Mô hình phân tích"]),
  e("ieee_features", "", "keep", ["Appendix C: To Be Determined List", "To Be Determined List", "Danh sách cần xác định"])
]

export const TEMPLATE_CATALOGS: Readonly<Record<Exclude<TemplateFamily, "fpt">, readonly TemplateEntry[]>> = {
  ieee830: IEEE_830,
  ieee_features: IEEE_FEATURES
}
