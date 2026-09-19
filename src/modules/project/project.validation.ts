import { z } from "zod"
import { Request, Response, NextFunction } from "express"
import { ApiError } from "../../shared/utils/api-error.js"
import { PROJECT_MODES } from "./project.model.js"

/** Không gửi `mode` ⇒ `fpt` (mode 2, hành vi cũ). */
export const projectModeSchema = z.enum(PROJECT_MODES).default("fpt")

export const CreateProjectSchema = z.object({
  name: z.string().trim().min(1).max(100),
  mode: projectModeSchema,
  domain: z.string().trim().max(100).optional(),
  /** Tạo thẳng trong thư mục của user. */
  folderId: z.string().min(1).optional()
})

export const RenameProjectSchema = z.object({
  name: z.string().min(1).max(100).trim()
})

/** `folderId: null` ⇒ đưa dự án ra khỏi thư mục. */
export const MoveProjectSchema = z.object({
  folderId: z.string().min(1).nullable()
})

export type MoveProjectDTO = z.infer<typeof MoveProjectSchema>
export type CreateProjectDTO = z.infer<typeof CreateProjectSchema>
export type RenameProjectDTO = z.infer<typeof RenameProjectSchema>

export const validateRequest = (schema: z.ZodSchema) => {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body)
    if (!result.success) {
      const errorMessage = result.error.issues.map((issue) => issue.message).join(", ")
      throw new ApiError(400, errorMessage, "VALIDATION_ERROR")
    }
    req.body = result.data
    next()
  }
}
