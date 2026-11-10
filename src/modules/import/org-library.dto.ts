/** FLF-278 trên FLF-335/336 — DTO mẫu và thư viện nội dung cấp tổ chức (`import-change-contract.md` §FLF-278). */
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
const contentBlockSchema = z.strictObject({ kind: z.enum(["paragraph", "list_item"]), text: z.string().trim().min(1).max(4000) })
export const contentEntrySchema = z.strictObject({ title: z.string().trim().min(1).max(200), blocks: z.array(contentBlockSchema).min(1).max(50) })
export const patchContentEntrySchema = contentEntrySchema
  .partial()
  .refine((v) => v.title !== undefined || v.blocks !== undefined, "Cần ít nhất một trường để sửa.")
export const saveSectionSchema = z.strictObject({ custom_section_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) })
