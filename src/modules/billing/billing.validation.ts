import { z } from "zod"
import { Request, Response, NextFunction } from "express"
import { ApiError } from "../../shared/utils/api-error.js"
import { PLAN_IDS } from "./plan.config.js"

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "ID không hợp lệ")

export const checkoutSchema = z.object({
  packageId: z.string().min(1, "packageId là bắt buộc").trim()
})

export const mockWebhookSchema = z.object({
  intentId: objectId,
  status: z.enum(["success", "failed"]),
  // Trình duyệt không gửi được header tuỳ biến qua CORS hiện tại,
  // nên chấp nhận chữ ký trong body như một phương án thay header.
  signature: z.string().optional()
})

export const upgradeSchema = z.object({
  plan: z.enum(PLAN_IDS as [string, ...string[]])
})

export const transactionsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20)
})

export type CheckoutDTO = z.infer<typeof checkoutSchema>
export type MockWebhookDTO = z.infer<typeof mockWebhookSchema>
export type UpgradeDTO = z.infer<typeof upgradeSchema>

export const validateBody = (schema: z.ZodType) => {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body ?? {})
    if (!result.success) {
      const errorMessage = result.error.issues.map((issue) => issue.message).join(", ")
      throw new ApiError(400, errorMessage, "VALIDATION_ERROR")
    }
    req.body = result.data
    next()
  }
}

export const parseQuery = <T extends z.ZodType>(schema: T, query: unknown): z.infer<T> => {
  const result = schema.safeParse(query)
  if (!result.success) {
    const errorMessage = result.error.issues.map((issue) => issue.message).join(", ")
    throw new ApiError(400, errorMessage, "VALIDATION_ERROR")
  }
  return result.data
}
