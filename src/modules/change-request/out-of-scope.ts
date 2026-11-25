/**
 * Mục riêng của file (`custom:*`) mà so cấu trúc đích xếp "ngoài phạm vi" (`TemplateProfile.target_structure`, status
 * `out_of_scope`). BF §3.2 + nguyên tắc 4: FlintFlow không soạn / không kiểm luật mục này - đã có nội dung ⇒ CR chỉ "sửa
 * chữ" (không kiểm luật Spine); còn trống ⇒ chỉ ghi chú (comment), không thêm nội dung.
 */

import { TemplateProfile } from "../import/template-profile.model.js"
import type { Spine } from "../spine/spine.types.js"
import { elementValue } from "./spine-location.js"
import { elementText } from "./location-display.js"

export type OutOfScopeKind = "text" | "comment"

/** Id section `custom:*` đang `out_of_scope` của dự án; chưa có so cấu trúc đích ⇒ rỗng. */
export const loadOutOfScopeSections = async (projectId: string): Promise<ReadonlySet<string>> => {
  const profile = (await TemplateProfile.findOne({ projectId }).select("target_structure").lean()) as { target_structure?: { sections?: { section_id: string; status: string }[] } | null } | null
  return new Set((profile?.target_structure?.sections ?? []).filter((s) => s.status === "out_of_scope" && s.section_id.startsWith("custom:")).map((s) => s.section_id))
}

/**
 * Vị trí thuộc mục ngoài phạm vi: `text` = đã có nội dung (sửa chữ, không kiểm luật), `comment` = còn trống (chỉ ghi chú);
 * `null` = mục trong phạm vi.
 */
export const outOfScopeKind = (spine: Spine, loc: { path: string; section_id: string }, outOfScope: ReadonlySet<string>): OutOfScopeKind | null => {
  if (!outOfScope.has(loc.section_id) || !loc.path.startsWith("custom_sections[")) return null
  return elementText(elementValue(spine, loc.path)).trim() ? "text" : "comment"
}
