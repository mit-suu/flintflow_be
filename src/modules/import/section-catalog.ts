/**
 * Danh mục section để khớp heading của tài liệu import (I-3, nút 1.6). FLF-171, plan §6 2B; P0 §3 dòng 5.
 * - Section cố định lấy từ `section-registry` (đóng băng) + tên gọi khác EN/VI.
 * - Heading nhóm (`2`, `2.2`, `3.1`…) chép từ `GROUP_HEADINGS` của `render/assemble.service.ts` (chưa export,
 *   ngoài vùng sở hữu) — nhóm không có nội dung riêng, không trích.
 * - Feature/function (§3.2 trở đi) chưa có id trước I-4 ⇒ id tạm `feature:@<block_id>` / `function:@<block_id>`,
 *   finalize đổi sang id thật.
 */

import { FIXED_SECTIONS } from "../spine/section-registry.js"
import { UNMAPPED_SECTION } from "./import.constants.js"
import { isContentSlot } from "./content-slots.js"
import { foldText, splitHeadingNumber } from "./text-similarity.js"
import { isPlaceholderText } from "./template-markers.js"

export interface SectionCandidate {
  id: string
  /** Số mục theo template FPT (`2.2.1`, `I`). */
  number: string
  kind: "fixed" | "group"
  titles: string[]
  required: boolean
}

const GROUP_HEADINGS: Readonly<Record<string, string>> = {
  "2": "User Requirements",
  "2.2": "Use Cases",
  "3": "Functional Requirements",
  "3.1": "System Functional Overview",
  "4": "Non-Functional Requirements",
  "4.2": "Quality Attributes",
  "5": "Requirement Appendix"
}

/** Tên gọi khác (EN/VI, và heading mẫu IEEE 830 — FLF-183) — thêm dần theo tài liệu thật gặp phải. */
const ALIASES: Readonly<Record<string, readonly string[]>> = {
  "fixed:I": ["Revision History", "Change History", "Lịch sử thay đổi", "Bảng theo dõi thay đổi"],
  "fixed:1": ["Introduction", "Overview", "Tổng quan sản phẩm", "Tổng quan", "Giới thiệu", "Purpose", "Scope", "Product Scope", "Product Perspective", "Mục đích", "Phạm vi"],
  "group:2": ["Yêu cầu người dùng"],
  "fixed:2.1": ["Actor", "Tác nhân", "Actors and Roles", "Tác nhân hệ thống", "User Characteristics", "User Classes and Characteristics", "Đặc điểm người dùng"],
  "group:2.2": ["Use Case", "Ca sử dụng"],
  "fixed:2.2.1": ["Diagram", "Diagrams", "Use Case Diagrams", "Sơ đồ use case", "Biểu đồ use case", "Biểu đồ ca sử dụng"],
  "fixed:2.2.2": ["Descriptions", "Use Case Description", "Use Case Specification", "Đặc tả use case", "Mô tả use case", "Đặc tả ca sử dụng"],
  "group:3": ["Yêu cầu chức năng", "Specific Requirements", "Yêu cầu cụ thể"],
  "group:3.1": ["Functional Overview", "Tổng quan chức năng", "Tổng quan chức năng hệ thống", "Product Functions", "Chức năng sản phẩm"],
  "fixed:3.1.1": ["Screen Flow", "Screens Flow Diagram", "Luồng màn hình", "Sơ đồ luồng màn hình"],
  "fixed:3.1.2": ["Screen Description", "Screens Description", "Mô tả màn hình", "Danh sách màn hình", "User Interfaces", "User Interface", "Giao diện người dùng"],
  "fixed:3.1.3": ["Authorization", "Screen Authorization Matrix", "Phân quyền màn hình", "Phân quyền"],
  "fixed:3.1.4": ["Non Screen Functions", "Non-Screen Function", "Chức năng không có màn hình", "Chức năng nền"],
  "fixed:3.1.5": ["ERD", "Entity Relationship", "Sơ đồ thực thể", "Sơ đồ quan hệ thực thể", "Data Model"],
  "group:4": ["Yêu cầu phi chức năng"],
  "fixed:4.1": [
    "Interfaces",
    "External Interface",
    "Giao diện ngoài",
    "Giao tiếp hệ thống ngoài",
    "External Interface Requirements",
    "System Interfaces",
    "Software Interfaces",
    "Hardware Interfaces",
    "Communications Interfaces",
    "Communication Interfaces"
  ],
  "group:4.2": ["Thuộc tính chất lượng", "Software System Attributes"],
  "fixed:4.2.1": ["Tính khả dụng", "Khả năng sử dụng", "Ease of Use", "Dễ sử dụng"],
  "fixed:4.2.2": ["Độ tin cậy", "Tính tin cậy", "Availability", "Tính sẵn sàng"],
  "fixed:4.2.3": ["Hiệu năng", "Hiệu suất", "Performance Requirements", "Yêu cầu hiệu năng"],
  "fixed:4.2.4": ["Domain Specific Attributes", "Thuộc tính đặc thù", "Security", "Maintainability", "Bảo mật", "Khả năng bảo trì"],
  "group:5": ["Appendix", "Phụ lục", "Phụ lục yêu cầu"],
  "fixed:5.1": ["Business Rule", "Quy tắc nghiệp vụ", "Luật nghiệp vụ"],
  "fixed:5.2": ["Common Requirement", "Yêu cầu chung"],
  "fixed:5.3": ["Messages", "Message List", "Application Messages", "Danh sách thông báo", "Thông báo hệ thống"],
  "fixed:5.4": ["Other Requirement", "Yêu cầu khác", "Assumptions and Dependencies", "Giả định và phụ thuộc"],
  "fixed:5.5": [
    "Glossary",
    "Terms",
    "Thuật ngữ",
    "Bảng thuật ngữ",
    "Định nghĩa thuật ngữ",
    "Definitions, Acronyms and Abbreviations",
    "Definitions, Acronyms & Abbreviations",
    "Definitions"
  ]
}

export const SECTION_CANDIDATES: readonly SectionCandidate[] = Object.freeze([
  ...FIXED_SECTIONS.map((s) => ({
    id: s.id,
    number: s.id.slice("fixed:".length),
    kind: "fixed" as const,
    titles: [s.title_en, ...(ALIASES[s.id] ?? [])],
    required: s.required
  })),
  ...Object.entries(GROUP_HEADINGS).map(([number, title]) => ({
    id: `group:${number}`,
    number,
    kind: "group" as const,
    titles: [title, ...(ALIASES[`group:${number}`] ?? [])],
    required: false
  }))
])

export const PROVISIONAL_SECTION = /^(feature|function):@(B\d{4,})$/

export const provisionalFeatureId = (blockId: string): string => `feature:@${blockId}`
export const provisionalFunctionId = (blockId: string): string => `function:@${blockId}`

export const isGroupSection = (id: string | null): boolean => !!id && id.startsWith("group:")

/** Section id hợp lệ cho PATCH mapping: section cố định, nhóm, id tạm feature/function hoặc `unmapped`. */
export const isKnownSectionId = (id: string): boolean =>
  id === UNMAPPED_SECTION || PROVISIONAL_SECTION.test(id) || isContentSlot(id) || SECTION_CANDIDATES.some((c) => c.id === id)

/** Section có nội dung để trích (không phải nhóm, không unmapped). */
export const isContentSection = (id: string | null): id is string => !!id && id !== UNMAPPED_SECTION && !isGroupSection(id)

/** `language: "vi"` ⇒ tên tiếng Việt đầu tiên trong danh sách (FLF-480): mẫu cố định hiện "Quy tắc nghiệp vụ" thay "Business Rule". */
export const sectionTitle = (id: string, language?: "vi" | "en"): string => {
  const titles = SECTION_CANDIDATES.find((c) => c.id === id)?.titles
  if (!titles) return id
  if (language === "vi") return titles.find((t) => /[^\x00-\x7f]/.test(t)) ?? titles[0]
  return titles[0]
}

/**
 * FLF-491: id mục khung theo danh mục cho heading đứng ngoài khung (`custom:*` / `unmapped`). Tên (bỏ số mục) trùng **đúng** một
 * tên trong `titles` của mục cố định ⇒ id đó. Tên là chỗ điền / rỗng mà số mục trùng số của một mục cố định ("4.2.4 …") ⇒ id đó.
 * Không so gần đúng. Không khớp ⇒ `null`.
 */
export const catalogSectionOf = (headingText: string): string | null => {
  const { number, title } = splitHeadingNumber(headingText)
  const fixed = SECTION_CANDIDATES.filter((c) => c.kind === "fixed")
  if (!title.trim() || isPlaceholderText(title)) return number ? (fixed.find((c) => c.number === number)?.id ?? null) : null
  const folded = foldText(title)
  if (!folded) return null
  return fixed.find((c) => c.titles.some((t) => foldText(t) === folded))?.id ?? null
}
