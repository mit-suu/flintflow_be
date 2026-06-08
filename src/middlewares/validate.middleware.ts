import { Request, Response, NextFunction } from "express"
import { ZodSchema } from "zod"
import { ApiError } from "../utils/ApiError.js"

export const validateMiddleware = (schema: ZodSchema) => {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = schema.safeParse(req.body)
      if (!result.success) {
        const message = result.error.issues.map((issue: any) => `${issue.path.join(".")}: ${issue.message}`).join(", ")
        throw new ApiError(400, message)
      }
      req.body = result.data
      next()
    } catch (error) {
      next(error)
    }
  }
}
