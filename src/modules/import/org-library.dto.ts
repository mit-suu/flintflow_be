/** FLF-278 trên FLF-335/336 — DTO mẫu cấp tổ chức (`import-change-contract.md` §FLF-278). */
import { z } from "zod"
import { TEMPLATE_INTENTS } from "../project/project.model.js"

const objectId = z.string().regex(/^[a-f0-9]{24}$/i, "Mã không hợp lệ.")

export const saveToOrgSchema = z.strictObject({ name: z.string().trim().min(1).max(120) })
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
export const importFromOrgSchema = z.strictObject({ org_template_id: objectId, intent: z.enum(TEMPLATE_INTENTS).optional() })
