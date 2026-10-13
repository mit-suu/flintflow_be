import { z } from "zod"
import { Request, Response, NextFunction } from "express"
import { validationError } from "../../shared/utils/validation-message.js"
import { USER_LOCALES } from "../../shared/i18n/locale.js"
import { PROJECT_MODES } from "./project.model.js"

/** Không gửi `mode` ⇒ `fpt` (mode 2, hành vi cũ). */
export const projectModeSchema = z.enum(PROJECT_MODES).default("fpt")

/** FLF-265: ngôn ngữ xem trước + .docx của dự án. Spine mode 2 vẫn tiếng Anh — chữ vi lấy từ lớp bản dịch. */
export const documentLanguageSchema = z.enum(USER_LOCALES)

export const CreateProjectSchema = z.object({
  name: z.string().trim().min(1).max(100),
  mode: projectModeSchema,
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
