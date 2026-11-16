/** DTO đổi mẫu (`docs/api/import-change-contract.md` §FLF-395 "Đổi mẫu"): body hợp lệ + hình trả về. */
import { z } from "zod"

const objectId = z.string().regex(/^[a-f0-9]{24}$/i, "Mã không hợp lệ.")
const key = z.string().min(1).max(200)

/** Bắt đầu bằng mẫu org: bất kỳ bản nào của họ mẫu (kể cả bản cũ hơn bản đang theo). */
export const startFromTemplateSchema = z.strictObject({ template_id: objectId, version: z.number().int().min(1) })

/**
 * Bắt đầu bằng file mẫu tải lên (multipart — field chữ đi kèm `file`). Analyst: bản riêng của dự án. Lead: `publish_to_org = "true"`
 * đăng lên thư viện org (họ mới cần `name`, hoặc `template_id` ⇒ bản mới của họ có sẵn).
 */
export const startFromFileSchema = z
  .strictObject({
    publish_to_org: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
    name: z.string().trim().min(1).max(120).optional(),
    template_id: objectId.optional()
  })
  .refine((v) => v.publish_to_org || (v.name === undefined && v.template_id === undefined), "name và template_id chỉ dùng khi đăng lên thư viện của tổ chức (publish_to_org).")

export const patchPairsSchema = z.strictObject({
  pairs: z.array(z.strictObject({ old_key: key, new_key: key.nullable() })).min(1).max(1000)
})

/** Sửa mapping heading → mục của file mẫu tải lên (bản riêng của dự án) lúc `mapping_review`. `section_id` được kiểm theo danh mục mục của FlintFlow ở service. */
export const patchMappingSchema = z.strictObject({
  edits: z.array(z.strictObject({ key: z.string().regex(/^n\d+$/, "Khoá heading không hợp lệ."), section_id: z.string().trim().min(1).max(100) })).min(1).max(1000)
})

export const migrationBatchActions = ["keep_all", "discard_all"] as const

export const patchDecisionsSchema = z
  .strictObject({
    decisions: z.array(z.strictObject({ id: key, choice: key })).max(1000).default([]),
    /** Đổi ngược: "Giữ hết" / "Hoàn tác hết" cho nhóm đã sửa sau lần đổi mẫu. */
    batch: z.enum(migrationBatchActions).optional()
  })
  .refine((v) => v.decisions.length > 0 || v.batch !== undefined, "Cần ít nhất một quyết định.")

export const migrationIdSchema = objectId
