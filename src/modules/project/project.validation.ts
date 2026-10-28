import { z } from "zod"
import { Request, Response, NextFunction } from "express"
import { validationError } from "../../shared/utils/validation-message.js"
import { USER_LOCALES } from "../../shared/i18n/locale.js"
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
