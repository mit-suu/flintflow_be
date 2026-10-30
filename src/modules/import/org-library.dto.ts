/** FLF-278 trên FLF-335/336 — DTO mẫu và thư viện nội dung cấp tổ chức (`import-change-contract.md` §FLF-278). */
import { z } from "zod"
import { TEMPLATE_INTENTS } from "../project/project.model.js"

const objectId = z.string().regex(/^[a-f0-9]{24}$/i, "Mã không hợp lệ.")

export const saveToOrgSchema = z.strictObject({ name: z.string().trim().min(1).max(120) })
export const importFromOrgSchema = z.strictObject({ org_template_id: objectId, intent: z.enum(TEMPLATE_INTENTS).optional() })
const contentBlockSchema = z.strictObject({ kind: z.enum(["paragraph", "list_item"]), text: z.string().trim().min(1).max(4000) })
export const contentEntrySchema = z.strictObject({ title: z.string().trim().min(1).max(200), blocks: z.array(contentBlockSchema).min(1).max(50) })
export const patchContentEntrySchema = contentEntrySchema
  .partial()
  .refine((v) => v.title !== undefined || v.blocks !== undefined, "Cần ít nhất một trường để sửa.")
export const saveSectionSchema = z.strictObject({ custom_section_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) })
