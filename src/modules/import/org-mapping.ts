/**
 * FLF-278 trên FLF-335/336 — áp mapping heading đã lưu của mẫu tổ chức lên lần import mới (gọi từ `import.service#runParse`).
 * Tách khỏi `org-library.service` để `import.service` không phụ thuộc vòng vào service thư viện.
 */
import { OrgTemplate, type OrgTemplateHeading } from "./org-library.model.js"
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

/** Mapping đã lưu của mẫu tổ chức. */
export const orgTemplateHeadings = async (orgTemplateId: unknown): Promise<OrgTemplateHeading[] | null> => {
  const t = await OrgTemplate.findById(orgTemplateId).select("headings").lean()
  return t?.headings ?? null
}
