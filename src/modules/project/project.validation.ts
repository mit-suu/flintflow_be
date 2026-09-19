import { z } from "zod"
import { Request, Response, NextFunction } from "express"
import { ApiError } from "../../shared/utils/api-error.js"
import { SOURCE_MODES } from "./project.model.js"

export const CreateProjectSchema = z.object({
  name: z.string().trim().min(1).max(100),
  sourceMode: z.enum(SOURCE_MODES),
  domain: z.string().trim().max(100).optional()
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
