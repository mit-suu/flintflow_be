/**
 * target-structure.ts — FLF-336, business-flow §3.1 I-5 "So cấu trúc đích" (lát 1).
 *
 * Sau khi Code dựng bố cục file và trích xong (I-4), so từng mục của **cấu trúc đích** với nội dung đã có ⇒ `present` /
 * `missing` / `out_of_scope`, rồi suy ra chế độ thật của dự án (§1 bảng "Lựa chọn khi tạo / Cấu trúc đích"):
 * - ý định `free` (tick "Bổ sung các mục còn thiếu theo mẫu chuẩn FlintFlow"): đích = khung của file **cộng** các mục của mẫu chuẩn
 *   FlintFlow ở mức tối thiểu (`REQUIRED_FIXED_SECTION_IDS`) mà file chưa có; đủ ⇒ chế độ 1, thiếu ⇒ **chế độ 4**. Heading riêng
 *   của file (`custom:*`) là mục của đích như mọi heading khác (có / thiếu), không tự thành `out_of_scope` chỉ vì không có trong mẫu
 *   chuẩn (FLF-463). FLF-455: `out_of_scope` theo loại nội dung 29148 (`out-of-scope.ts`), áp cho mọi chế độ.
 * - ý định `fixed` (mặc định, không tick): đích = chính các heading của file; heading có mà trống ⇒ `missing`
 *   ⇒ **chế độ 3** (chỉ soạn mục mẫu có, không thêm, không đổi thứ tự); mục FPT mẫu không có chỉ là cờ vàng (lát sau).
 * - FLF-463 (đảo FLF-378 luồng C): mục đã viết luôn là `present`, kể cả khi màn đọc khung gắn nhãn "Khung mẫu" (ngưỡng 20% chỉ để
 *   gắn nhãn). Mục người dùng Bỏ chữ (`emptied`) tính là còn trống để Luồng 2 soạn lại.
 * Hàm thuần — finalize gọi trước khi chụp v0: còn `missing` ⇒ **không có v0 dở dang** (§1), import dừng ở `incomplete`.
 */

import type { Spine } from "../spine/spine.types.js"
import { REQUIRED_FIXED_SECTION_IDS, stepsOf } from "../spine/section-registry.js"
import { sectionHasData } from "../spine/deterministic-check.js"
import { sectionTitle } from "./section-catalog.js"
import type { LayoutEntry } from "./template-profile.model.js"
import { isContentSlot, slotHasData } from "./content-slots.js"
import { templateWrapperIds } from "./template-wrappers.js"
import { displayHeading } from "./heading-label.js"
import { templateSectionOwnerSteps } from "./template-step-headings.js"
import { isPlaceholderText } from "./template-markers.js"
import { splitHeadingNumber } from "./text-similarity.js"
import { isOutOfScopeHeading } from "./out-of-scope.js"

export type TargetSectionStatus = "present" | "missing" | "out_of_scope"
export type TemplateIntent = "fixed" | "free"
export type ResolvedMode = 1 | 3 | 4

export interface TargetSection {
  section_id: string
  title: string
  status: TargetSectionStatus
  /** Bước Luồng 2 soạn mục này (để lát sau chỉ chạy step của phần thiếu). */
  owner_steps: string[]
}

export interface TargetStructure {
  /** `fpt` = mẫu chuẩn FlintFlow tối thiểu; `template` = chính mẫu của file. */
  target: "fpt" | "template"
  intent: TemplateIntent
  resolved_mode: ResolvedMode
  sections: TargetSection[]
  /** Id các mục `missing` — rỗng ⇒ đủ cấu trúc đích ⇒ chế độ 1. */
  missing: string[]
  compared_at: string
}

/** Mục không soạn: Record of Changes (tự sinh từ lịch sử thay đổi). */
const DERIVED_SECTIONS: ReadonlySet<string> = new Set(["fixed:I"])

/** Bìa / mục lục của mẫu: Word / hệ thống tự dựng, không phải mục cần soạn (FLF-378). */
const NON_DRAFT_TITLES: ReadonlySet<string> = new Set(
  ["table of contents", "table of contents and index", "contents", "mục lục", "cover", "cover page", "title page", "trang bìa", "bìa"]
)
const normalizeTitle = (text: string): string =>
  text.trim().replace(/^[\dIVXivx]+(\.[\dIVXivx]+)*\.?\s+/, "").replace(/\s+/g, " ").toLowerCase()
export const isNonDraftHeading = (sectionId: string, headingText: string): boolean =>
  DERIVED_SECTIONS.has(sectionId) || NON_DRAFT_TITLES.has(normalizeTitle(headingText)) || isPlaceholderHeading(sectionId, headingText)

/**
 * FLF-411: heading chỗ điền của mẫu ("4.2.4 …", "5.3 …") không phải mục cần soạn / mục bắt buộc. Khung tính năng / chức năng
 * (`3.2 <<Feature Name 1>>` ⇒ `feature:*` / `function:*`) vẫn là chỗ in tính năng thật nên không tính.
 */
const isPlaceholderHeading = (sectionId: string, headingText: string): boolean =>
  !/^(feature|function):/.test(sectionId) && isPlaceholderText(splitHeadingNumber(headingText).title)

export interface CompareOptions {
  /**
   * FLF-463: mục người dùng chọn Bỏ chữ ở màn đọc khung — chỉ còn khung nên tính là còn trống (Luồng 2 soạn lại), kể cả khi Spine
   * có dữ liệu của mục đó lấy từ chỗ khác trong file.
   */
  emptied?: ReadonlySet<string>
  /**
   * FLF-455: mục riêng (`custom:*`) mà I-4 xếp ngoài SRS theo 29148 (`outOfScopeSectionIds`). Mục riêng còn trống mà heading thuộc
   * loại ngoài SRS (dự toán chi phí) cũng là Ngoài phạm vi - xét trong hàm này, không cần AI.
   */
  outOfScope?: ReadonlySet<string>
}

const hasContent = (spine: Spine, sectionId: string, withContent: ReadonlySet<string>): boolean => {
  // Phần nhỏ (`slot:*`, FLF-278): đúng phần dữ liệu của nó, hoặc chữ thật dưới heading
  if (isContentSlot(sectionId)) return slotHasData(spine, sectionId) || withContent.has(sectionId)
  try {
    if (sectionHasData(spine, sectionId)) return true
  } catch {
    // mục không có trong bảng kiểm tất định (custom / feature) ⇒ chỉ xét chữ trong file
  }
  return withContent.has(sectionId)
}

/** Có mục con (heading cấp sâu hơn đứng ngay sau, tới heading cùng cấp / cấp trên kế tiếp) có nội dung. */
const childHasContent = (ordered: readonly LayoutEntry[], index: number, spine: Spine, withContent: ReadonlySet<string>): boolean => {
  const level = ordered[index].level
  for (let j = index + 1; j < ordered.length && ordered[j].level > level; j++) {
    const child = ordered[j].section_id
    if (!child.startsWith("group:") && hasContent(spine, child, withContent)) return true
  }
  return false
}

/** Tiêu đề của mục theo file upload, kèm số Word tự đánh (FLF-362); mục không có trong file ⇒ tên mẫu. */
const titleOf = (sectionId: string, layout: readonly LayoutEntry[]): string => {
  const entry = layout.find((l) => l.section_id === sectionId)
  return (entry?.heading_text?.trim() && displayHeading(entry.heading_text, entry.number_label)) || sectionTitle(sectionId)
}

/**
 * Mục của chính file theo thứ tự heading (bỏ nhóm bao `group:*` — không có nội dung riêng — và phần nối: mục riêng tiêu đề rỗng
 * gom khối dưới heading nhóm / khối không trích, thuộc mục đứng trước chứ không phải heading của file).
 */
const fileSections = (
  layout: readonly LayoutEntry[],
  withContent: ReadonlySet<string>,
  spine: Spine,
  emptied: ReadonlySet<string>,
  outOfScope: ReadonlySet<string>
): TargetSection[] => {
  const sections: TargetSection[] = []
  const has = (id: string) => !emptied.has(id) && hasContent(spine, id, withContent)
  const seen = new Set<string>()
  const wrappers = templateWrapperIds(layout)
  const ordered = [...layout].sort((a, b) => a.order - b.order)
  for (const [i, entry] of ordered.entries()) {
    if (entry.section_id.startsWith("group:") || seen.has(entry.section_id)) continue
    if (entry.section_id.startsWith("custom:") && !entry.heading_text.trim()) continue
    seen.add(entry.section_id)
    // FLF-379: Record of Changes / Revision History tự sinh từ lịch sử thay đổi — không phải mục cần soạn
    if (DERIVED_SECTIONS.has(entry.section_id)) continue
    const own = has(entry.section_id)
    // Heading bao chỉ chứa mục con (vd "2 Overall Description") không phải mục cần soạn
    if (wrappers.has(entry.section_id) && !own) continue
    // FLF-455 (BF nguyên tắc 4): Ngoài phạm vi theo loại nội dung 29148, mọi chế độ - giữ nguyên, không soạn, không kiểm
    if (entry.section_id.startsWith("custom:") && (outOfScope.has(entry.section_id) || (!has(entry.section_id) && isOutOfScopeHeading(entry.heading_text)))) {
      sections.push({ section_id: entry.section_id, title: titleOf(entry.section_id, layout), status: "out_of_scope", owner_steps: [] })
      continue
    }
    // FLF-379: heading chỉ có mục con (tính năng "3.2 Course Registration" ⇒ chức năng 3.2.1…) — mục con có nội dung thì
    // mục cha đã có nội dung, không "Sẽ soạn"
    const present = own || childHasContent(ordered, i, spine, withContent)
    // Bìa / mục lục / heading chỗ điền của mẫu còn trống không phải mục cần soạn (FLF-378, FLF-411)
    if (!present && isNonDraftHeading(entry.section_id, entry.heading_text)) continue
    sections.push({ section_id: entry.section_id, title: titleOf(entry.section_id, layout), status: present ? "present" : "missing", owner_steps: templateSectionOwnerSteps(entry.section_id, spine) })
  }
  return sections
}

export const compareTargetStructure = (
  layout: readonly LayoutEntry[],
  withContent: ReadonlySet<string>,
  spine: Spine,
  intent: TemplateIntent,
  at: string = new Date().toISOString(),
  opts: CompareOptions = {}
): TargetStructure => {
  const emptied = opts.emptied ?? new Set<string>()
  const sections = fileSections(layout, withContent, spine, emptied, opts.outOfScope ?? new Set())
  if (intent === "free") {
    // Mẫu chuẩn FlintFlow là mức tối thiểu: mục bắt buộc file chưa có ⇒ thêm vào đích (có dữ liệu trong Spine từ chỗ khác ⇒ có)
    for (const id of REQUIRED_FIXED_SECTION_IDS) {
      if (DERIVED_SECTIONS.has(id) || sections.some((s) => s.section_id === id)) continue
      const present = !emptied.has(id) && hasContent(spine, id, withContent)
      sections.push({ section_id: id, title: titleOf(id, layout), status: present ? "present" : "missing", owner_steps: stepsOf(id, spine) })
    }
  }
  const missing = sections.filter((s) => s.status === "missing").map((s) => s.section_id)
  const resolved_mode: ResolvedMode = missing.length === 0 ? 1 : intent === "fixed" ? 3 : 4
  return { target: intent === "fixed" ? "template" : "fpt", intent, resolved_mode, sections, missing, compared_at: at }
}
