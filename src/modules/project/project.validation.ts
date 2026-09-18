import { z } from "zod"
import { Request, Response, NextFunction } from "express"
import { ApiError } from "../../shared/utils/api-error.js"
import { PROJECT_MODES } from "./project.model.js"

/** Không gửi `mode` ⇒ `fpt` (mode 2, hành vi cũ). */
export const projectModeSchema = z.enum(PROJECT_MODES).default("fpt")

export const CreateProjectSchema = z.object({
  name: z.string().min(1).max(100).trim(),
  mode: projectModeSchema
})

export const RenameProjectSchema = z.object({
  name: z.string().min(1).max(100).trim()
})

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
