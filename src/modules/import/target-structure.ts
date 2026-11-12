/**
 * target-structure.ts — FLF-336, business-flow §3.1 I-5 "So cấu trúc đích" (lát 1).
 *
 * Sau khi Code dựng bố cục file và trích xong (I-4), so từng mục của **cấu trúc đích** với nội dung đã có ⇒ `present` /
 * `missing` / `out_of_scope`, rồi suy ra chế độ thật của dự án (§1 bảng "Lựa chọn khi tạo / Cấu trúc đích"):
 * - ý định `free` (có sẵn · tự do): đích = mẫu chuẩn FlintFlow ở mức tối thiểu (`REQUIRED_FIXED_SECTION_IDS`); đủ ⇒ chế độ 1,
 *   thiếu ⇒ **chế độ 4** (bổ sung + sắp lại bố cục). Mục riêng của file (`custom:*`) là `out_of_scope` — giữ nguyên, xuống cuối.
 * - ý định `fixed` (theo mẫu cố định / mẫu bắt buộc): đích = chính các heading của file; heading có mà trống ⇒ `missing`
 *   ⇒ **chế độ 3** (chỉ soạn mục mẫu có, không thêm, không đổi thứ tự); mục FPT mẫu không có chỉ là cờ vàng (lát sau).
 * - FLF-378 (luồng C — **dự án mới** + mẫu bắt buộc, `draftAll`): file là **mẫu** (trống / hướng dẫn / ví dụ), không phải dữ
 *   liệu ⇒ chữ ngoài ngoặc chỉ là ví dụ, không làm mục thành "đã có". Mọi mục của mẫu (trừ Record of Changes, bìa, mục lục)
 *   là `missing` và luôn **chế độ 3** — FlintFlow soạn đủ mọi mục, kể cả khi mục nào của mẫu cũng có ví dụ.
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
   * FLF-378: dự án mới theo mẫu bắt buộc (`start_kind = new`, `template_intent = fixed`) — soạn đủ mọi mục của mẫu, chữ trong
   * mẫu không tính là nội dung. Chỉ có tác dụng với ý định `fixed`.
   */
  draftAll?: boolean
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

export const compareTargetStructure = (
  layout: readonly LayoutEntry[],
  withContent: ReadonlySet<string>,
  spine: Spine,
  intent: TemplateIntent,
  at: string = new Date().toISOString(),
  opts: CompareOptions = {}
): TargetStructure => {
  const sections: TargetSection[] = []
  const draftAll = intent === "fixed" && opts.draftAll === true
  if (intent === "fixed") {
    // Đích = heading của chính mẫu (bỏ nhóm bao `group:*` — không có nội dung riêng — và phần nối: mục riêng tiêu đề rỗng
    // gom khối dưới heading nhóm / khối không trích, thuộc mục đứng trước chứ không phải heading của mẫu)
    const seen = new Set<string>()
    const wrappers = templateWrapperIds(layout)
    const ordered = [...layout].sort((a, b) => a.order - b.order)
    for (const [i, entry] of ordered.entries()) {
      if (entry.section_id.startsWith("group:") || seen.has(entry.section_id)) continue
      if (entry.section_id.startsWith("custom:") && !entry.heading_text.trim()) continue
      seen.add(entry.section_id)
      // FLF-379: Record of Changes / Revision History tự sinh từ lịch sử thay đổi — không phải mục cần soạn
      if (DERIVED_SECTIONS.has(entry.section_id)) continue
      if (draftAll && isNonDraftHeading(entry.section_id, entry.heading_text)) continue
      // FLF-378: dự án mới theo mẫu bắt buộc — chữ trong mẫu không tính là nội dung
      const own = draftAll ? false : hasContent(spine, entry.section_id, withContent)
      // Heading bao chỉ chứa mục con (vd "2 Overall Description") không phải mục cần soạn
      if (wrappers.has(entry.section_id) && !own) continue
      // FLF-379: heading chỉ có mục con (tính năng "3.2 Course Registration" ⇒ chức năng 3.2.1…) — mục con có nội dung thì
      // mục cha đã có nội dung, không "Sẽ soạn"
      const present = !draftAll && (own || childHasContent(ordered, i, spine, withContent))
      const owners = templateSectionOwnerSteps(entry.section_id, spine)
      sections.push({ section_id: entry.section_id, title: titleOf(entry.section_id, layout), status: present ? "present" : "missing", owner_steps: owners })
    }
  } else {
    for (const id of REQUIRED_FIXED_SECTION_IDS) {
      const present = hasContent(spine, id, withContent)
      sections.push({ section_id: id, title: titleOf(id, layout), status: present ? "present" : "missing", owner_steps: stepsOf(id, spine) })
    }
    // FLF-411 (U3-2…U3-4): mục của file ngoài mẫu FPT. Tính năng / chức năng của file (3.2 Account › 3.2.1 Register…) là phần
    // Functional Requirements của mẫu FPT ⇒ có / thiếu như mục FPT, không gộp thành một mục riêng. Phần nối (mục riêng tiêu đề
    // rỗng) và heading bao chỉ chứa mục con ("II. Software Requirement Specification") không phải mục — không "Ngoài phạm vi"
    const seen = new Set<string>()
    const wrappers = templateWrapperIds(layout)
    const ordered = [...layout].sort((a, b) => a.order - b.order)
    for (const [i, entry] of ordered.entries()) {
      const id = entry.section_id
      if (seen.has(id)) continue
      seen.add(id)
      if (/^(feature|function):/.test(id)) {
        if (wrappers.has(id) && !hasContent(spine, id, withContent)) continue
        const present = hasContent(spine, id, withContent) || childHasContent(ordered, i, spine, withContent)
        sections.push({ section_id: id, title: titleOf(id, layout), status: present ? "present" : "missing", owner_steps: templateSectionOwnerSteps(id, spine) })
        continue
      }
      // Mục FPT của file ngoài danh sách tối thiểu (vd 4.2.4 Security) có nội dung ⇒ vẫn hiện "có", không biến mất khỏi bản đồ
      if (!id.startsWith("custom:") && !id.startsWith("group:") && !sections.some((s) => s.section_id === id)) {
        if (!DERIVED_SECTIONS.has(id) && hasContent(spine, id, withContent)) sections.push({ section_id: id, title: titleOf(id, layout), status: "present", owner_steps: stepsOf(id, spine) })
        continue
      }
      if (!id.startsWith("custom:") || !entry.heading_text.trim()) continue
      if (isNonDraftHeading(id, entry.heading_text)) continue
      if (wrappers.has(id) && !withContent.has(id)) continue
      sections.push({ section_id: id, title: titleOf(id, layout), status: "out_of_scope", owner_steps: [] })
    }
  }
  const missing = sections.filter((s) => s.status === "missing").map((s) => s.section_id)
  // FLF-378: dự án mới theo mẫu bắt buộc luôn chế độ 3 (không bao giờ chụp bản 0.1 từ mẫu)
  const resolved_mode: ResolvedMode = draftAll ? 3 : missing.length === 0 ? 1 : intent === "fixed" ? 3 : 4
  return { target: intent === "fixed" ? "template" : "fpt", intent, resolved_mode, sections, missing, compared_at: at }
}
