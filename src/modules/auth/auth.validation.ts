import { z } from "zod"
import { Request, Response, NextFunction } from "express"
import { ApiError } from "../../shared/utils/api-error.js"

export const loginSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(6, "Password must be at least 6 characters")
})

export type LoginDTO = z.infer<typeof loginSchema>

export const registerSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(6, "Password must be at least 6 characters")
})

export type RegisterDTO = z.infer<typeof registerSchema>

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
