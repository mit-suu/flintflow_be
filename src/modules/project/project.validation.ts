import { z } from "zod"
import { Request, Response, NextFunction } from "express"
import { validationError } from "../../shared/utils/validation-message.js"
import { USER_LOCALES } from "../../shared/i18n/locale.js"
import { ERD_NOTATIONS } from "../../shared/diagram/erd-notation.js"
import { SEQUENCE_LEVELS } from "../../shared/diagram/sequence-level.js"
import { HEX_COLOR, MAX_DOMAIN_LENGTH, normalizeDomain, SCREEN_MOCKUP_MODES, SCREEN_PLATFORMS } from "../../shared/diagram/screen-theme.js"
import { PROJECT_MODES, PROJECT_START_KINDS } from "./project.model.js"

/** Client cũ (trước FLF-335) gửi `mode`; không gửi ⇒ `fpt`. Có `source` thì `mode` bị bỏ qua — Code suy ra. */
export const projectModeSchema = z.enum(PROJECT_MODES).default("fpt")
/** FLF-335: `new` / `existing`. */
export const projectStartKindSchema = z.enum(PROJECT_START_KINDS)

/** FLF-265: ngôn ngữ xem trước + .docx của dự án. Spine mode 2 vẫn tiếng Anh — chữ vi lấy từ lớp bản dịch. */
export const documentLanguageSchema = z.enum(USER_LOCALES)

export const CreateProjectSchema = z.object({
  name: z.string().trim().min(1).max(100),
  mode: projectModeSchema,
  /** FLF-335 (business-flow §1): dự án mới / dự án có sẵn — BE suy ra `mode`. */
  source: projectStartKindSchema.optional(),
  /** Chỉ với `source: "new"`: khách có bắt buộc theo một mẫu không (có ⇒ `import`, tải mẫu lên; không ⇒ `fpt`). */
  has_required_template: z.boolean().optional(),
  /**
   * Hộp Tạo dự án (business-flow §1): có tải file SRS lên không. Có trường này thì `source` / `has_required_template` / `mode`
   * bị bỏ qua — Code suy ra chế độ từ hai lựa chọn còn lại của người dùng.
   */
  has_srs_file: z.boolean().optional(),
  /** Chỉ khi `has_srs_file`: "Bổ sung các mục còn thiếu theo mẫu chuẩn FlintFlow" (mặc định không ⇒ giữ khung của file). */
  complete_to_standard: z.boolean().optional(),
  domain: z.string().trim().max(100).optional(),
  /** Tạo thẳng trong thư mục của user. */
  folderId: z.string().min(1).optional(),
  /** FLF-265: thiếu ⇒ `User.locale` ⇒ `en`. Mode `import` bỏ qua — ngôn ngữ lấy theo file upload. */
  documentLanguage: documentLanguageSchema.optional()
})

/** FLF-265: PATCH /projects/:id/document-language (Lead/Analyst). */
export const UpdateDocumentLanguageSchema = z.strictObject({
  documentLanguage: documentLanguageSchema
})

/** PATCH /projects/:id/erd-notation (Lead/Analyst): ký pháp ERD của dự án. */
export const UpdateErdNotationSchema = z.strictObject({
  erdNotation: z.enum(ERD_NOTATIONS)
})

/** PATCH /projects/:id/sequence-level (Lead/Analyst, FLF-418): mức Sequence Diagram của dự án. */
export const UpdateSequenceLevelSchema = z.strictObject({
  sequenceLevel: z.enum(SEQUENCE_LEVELS)
})

/**
 * PATCH /projects/:id/screen-theme (Lead/Analyst, FLF-410): theme mockup màn. Gửi field nào đổi field đó (ít nhất một);
 * `null` = về mặc định. Domain nhận cả URL (`https://shop.vn/`) ⇒ chuẩn hoá thành hostname; chuỗi rỗng = `null`.
 */
export const UpdateScreenThemeSchema = z
  .strictObject({
    primaryColor: z.string().regex(HEX_COLOR, "Màu chính phải dạng #RRGGBB.").transform((c) => c.toUpperCase()).nullable().optional(),
    domain: z
      .string()
      .trim()
      .max(MAX_DOMAIN_LENGTH + 16)
      .nullable()
      .optional()
      .transform((d, ctx) => {
        if (d === undefined || d === null || d === "") return d === undefined ? undefined : null
        const host = normalizeDomain(d)
        if (!host) {
          ctx.addIssue({ code: "custom", message: "Domain không hợp lệ (vd: shop.example.com)." })
          return z.NEVER
        }
        return host
      }),
    platforms: z
      .array(z.enum(SCREEN_PLATFORMS))
      .min(1, "Chọn ít nhất một nền tảng.")
      .refine((p) => new Set(p).size === p.length, "Nền tảng bị trùng.")
      .nullable()
      .optional()
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), "Cần ít nhất một trường để đổi.")

/** FLF-410: POST /projects/:id/screen-mockups — vẽ lại ảnh gốc bằng mockup (một màn / mọi màn có ảnh gốc). */
export const RunScreenMockupsSchema = z
  .strictObject({
    mode: z.enum(SCREEN_MOCKUP_MODES),
    scope: z.enum(["screen", "all"]),
    screen_id: z.string().trim().min(1).max(40).optional(),
    /** Nhiều màn một lượt (thử lại các màn lỗi) — dùng với scope = screen thay `screen_id`. */
    screen_ids: z.array(z.string().trim().min(1).max(40)).min(1).max(200).optional()
  })
  .refine((v) => v.scope === "all" || v.screen_id !== undefined || v.screen_ids !== undefined, { message: "Cần screen_id hoặc screen_ids khi scope = screen.", path: ["screen_id"] })

/** FLF-410: DELETE /projects/:id/screen-mockups — dùng lại ảnh gốc, giữ hình đã vẽ. */
export const DisableScreenMockupsSchema = z
  .strictObject({ scope: z.enum(["screen", "all"]), screen_id: z.string().trim().min(1).max(40).optional() })
  .refine((v) => v.scope === "all" || v.screen_id !== undefined, { message: "Cần screen_id khi scope = screen.", path: ["screen_id"] })

/** FLF-410: query của GET /projects/:id/screen-mockups — có `mode` ⇒ ước tính credit, không ⇒ tóm tắt. */
export const ScreenMockupsQuerySchema = z.object({
  mode: z.enum(SCREEN_MOCKUP_MODES).optional(),
  scope: z.enum(["screen", "all"]).optional(),
  screen_id: z.string().trim().min(1).max(40).optional()
})

export const RenameProjectSchema = z.object({
  name: z.string().min(1).max(100).trim()
})

/** `folderId: null` ⇒ đưa dự án ra khỏi thư mục. */
export const MoveProjectSchema = z.object({
  folderId: z.string().min(1).nullable()
})

/**
 * FLF-267: body của `POST /chats/:chatId/messages(/stream)` chỉ kiểm thêm cờ `knowledge` (boolean thật — `"true"` bị từ
 * chối); `content` / `step` giữ cách kiểm cũ của controller để mã lỗi `CONTENT_REQUIRED` / `STEP_REQUIRED` không đổi.
 */
/** Thứ tự danh sách dự án: tạo mới nhất (lưới mặc định) · sửa gần nhất · mở gần nhất (dự án chưa mở xếp cuối). */
export const PROJECT_LIST_SORTS = ["created", "updated", "opened"] as const
export type ProjectListSort = (typeof PROJECT_LIST_SORTS)[number]

/**
 * `GET /projects?page=…` (FLF-404): dashboard tải theo trang, lọc / tìm / sắp xếp ở BE. Không có `page` ⇒ endpoint trả
 * mảng như cũ (client cũ, bộ lọc của trang Thanh toán). `folder`: id thư mục, hoặc `none` = dự án ngoài thư mục.
 */
export const ListProjectsQuerySchema = z.object({
  page: z.coerce.number().int().min(1),
  limit: z.coerce.number().int().min(1).max(100).default(24),
  status: z.enum(["active", "archived"], { message: "Trạng thái dự án không hợp lệ." }).optional(),
  mode: z.enum(PROJECT_MODES, { message: "Cách làm SRS không hợp lệ." }).optional(),
  q: z.string().trim().max(100, "Từ khoá tối đa 100 ký tự").optional(),
  sort: z.enum(PROJECT_LIST_SORTS, { message: "Cách sắp xếp không hợp lệ." }).default("created"),
  folder: z.union([z.literal("none"), z.string().regex(/^[a-f\d]{24}$/i, "Mã thư mục không hợp lệ.")]).optional()
})
export type ListProjectsQuery = z.infer<typeof ListProjectsQuerySchema>

export const ChatKnowledgeFlagSchema = z.object({
  knowledge: z.boolean({ error: "Cờ hỏi tri thức (knowledge) phải là true hoặc false." }).optional()
})

/** Thiếu ⇒ `false`; sai kiểu ⇒ 400 `VALIDATION_ERROR`. */
export const parseKnowledgeFlag = (body: unknown): boolean => {
  const result = ChatKnowledgeFlagSchema.safeParse(body ?? {})
  if (!result.success) throw validationError(result.error)
  return result.data.knowledge ?? false
}

export type MoveProjectDTO = z.infer<typeof MoveProjectSchema>
export type CreateProjectDTO = z.infer<typeof CreateProjectSchema>
export type RenameProjectDTO = z.infer<typeof RenameProjectSchema>
export type UpdateErdNotationDTO = z.infer<typeof UpdateErdNotationSchema>
export type UpdateSequenceLevelDTO = z.infer<typeof UpdateSequenceLevelSchema>
export type UpdateScreenThemeDTO = z.infer<typeof UpdateScreenThemeSchema>
export type RunScreenMockupsDTO = z.infer<typeof RunScreenMockupsSchema>
export type DisableScreenMockupsDTO = z.infer<typeof DisableScreenMockupsSchema>
export type UpdateDocumentLanguageDTO = z.infer<typeof UpdateDocumentLanguageSchema>

export const validateRequest = (schema: z.ZodSchema) => {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body)
    if (!result.success) {
      throw validationError(result.error)
    }
    req.body = result.data
    next()
  }
}
