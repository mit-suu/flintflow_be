/**
 * FLF-278 trên FLF-335/336 — áp mapping heading đã lưu của mẫu tổ chức lên lần import mới (gọi từ `import.service#runParse`).
 * Tách khỏi `org-library.service` để `import.service` không phụ thuộc vòng vào service thư viện.
 */
import type mongoose from "mongoose"
import { OrgTemplate, OrgTemplateVersion, type OrgTemplateHeading } from "./org-library.model.js"
import type { HeadingMapEntry } from "./template-profile.model.js"

/** Khoá so khớp tiêu đề mục: bỏ số gõ tay đầu dòng, dấu câu, hoa/thường, khoảng trắng; giữ dấu tiếng Việt. */
export const normalizeTitle = (text: string): string =>
  text
    .normalize("NFC")
    .toLowerCase()
    .replace(/^\s*(?:\d+(?:\.\d+)*[.)]?|[ivxlc]+[.)]|[a-z][.)])\s+/u, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()

/**
 * Áp mapping đã lưu lên heading vừa đọc lại từ cùng file mẫu: cùng thứ tự + cùng tiêu đề ⇒ lấy `section_id` BA đã xác
 * nhận (đã xác nhận, độ tin 1). Heading lệch (file khác bản) giữ đề xuất của matcher, BA xác nhận lại ở 1.5.
 */
export const applyOrgMapping = (entries: readonly HeadingMapEntry[], saved: readonly OrgTemplateHeading[]): HeadingMapEntry[] =>
  entries.map((e, i) => {
    const s = saved[i]
    return s && normalizeTitle(s.heading_text) === normalizeTitle(e.heading_text) ? { ...e, section_id: s.section_id, confidence: 1, confirmed: true } : e
  })

/**
 * Mapping đã lưu của mẫu tổ chức theo đúng bản lúc import (FLF-395) — không theo bản mới nhất. Import cũ (trước FLF-395,
 * không có `version`) ⇒ bản 1 nếu họ đã migrate, chưa migrate thì mapping nằm trên họ mẫu.
 */
export const orgTemplateHeadings = async (orgTemplateId: mongoose.Types.ObjectId | string, version: number | null = null): Promise<OrgTemplateHeading[] | null> => {
  const v = await OrgTemplateVersion.findOne({ template_id: orgTemplateId, version: version ?? 1 }).select("headings").lean()
  if (v) return v.headings
  if (version) return null
  const t = await OrgTemplate.findById(orgTemplateId).select("headings").lean()
  return t?.headings ?? null
}
