/** FLF-278 trên FLF-335/336 — DTO mẫu cấp tổ chức (`import-change-contract.md` §FLF-278). */
import { z } from "zod"
import { TEMPLATE_INTENTS } from "../project/project.model.js"

const objectId = z.string().regex(/^[a-f0-9]{24}$/i, "Mã không hợp lệ.")

/** FLF-395: `template_id` ⇒ lưu thành bản mới của mẫu có sẵn (tên bỏ qua). */
export const saveToOrgSchema = z.strictObject({ name: z.string().trim().min(1).max(120), template_id: objectId.optional() })
/** FLF-395 (D16): `version` trống ⇒ bản đã đăng mới nhất. */
export const importFromOrgSchema = z.strictObject({ org_template_id: objectId, version: z.number().int().min(1).optional(), intent: z.enum(TEMPLATE_INTENTS).optional() })
/** FLF-395: field chữ đi kèm file mẫu (multipart). Tên chỉ cần khi tạo mẫu mới. */
export const uploadTemplateSchema = z.strictObject({ name: z.string().trim().min(1).max(120).optional() })
/** FLF-395: Lead sửa mapping tự nhận theo vị trí heading rồi đăng. */
export const publishVersionSchema = z.strictObject({
  headings: z.array(z.strictObject({ index: z.number().int().min(0), section_id: z.string().min(1).max(120) })).max(1000).default([])
})
export const versionParamSchema = z.coerce.number().int().min(1)
/** FLF-395 (D13): duyệt mục BA tự đặt của mẫu khung. */
export const skeletonDecisionsSchema = z.strictObject({
  decisions: z
    .array(z.strictObject({ key: z.string().regex(/^B\d{4,}$/), decision: z.enum(["keep", "generic", "drop"]), generic_text: z.string().trim().min(1).max(300).optional() }))
    .min(1)
    .max(200)
})
/**
 * Trang Thư viện mẫu: tìm (không phân biệt dấu) theo tên mẫu / tên file, sắp xếp, phân trang để FE tải dần khi cuộn.
 * Không có `page` ⇒ route trả danh sách cũ (ô chọn mẫu lúc tạo dự án), không đổi hành vi client cũ.
 */
export const templatesQuerySchema = z.object({
  q: z.string().trim().max(100, "Từ khoá tối đa 100 ký tự").optional(),
  sort: z.enum(["uses", "recent", "name"]).default("uses"),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20)
})
export type TemplatesQuery = z.infer<typeof templatesQuerySchema>
