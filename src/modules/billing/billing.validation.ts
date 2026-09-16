import { z } from "zod"
import { Request, Response, NextFunction } from "express"
import { ApiError } from "../../shared/utils/api-error.js"
import { PLAN_IDS } from "./plan.config.js"

export const checkoutSchema = z.object({
  packageId: z.string().min(1, "packageId là bắt buộc").trim()
})

/** Body payment_service POST về callback_url (guide: order_id, status, client_id). */
export const paymentCallbackSchema = z.object({
  order_id: z.string().min(1, "order_id là bắt buộc"),
  status: z.string().min(1, "status là bắt buộc"),
  client_id: z.string().min(1, "client_id là bắt buộc")
})

export const upgradeSchema = z.object({
  plan: z.enum(PLAN_IDS as [string, ...string[]])
})

export const transactionsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20)
})

export type CheckoutDTO = z.infer<typeof checkoutSchema>
export type PaymentCallbackDTO = z.infer<typeof paymentCallbackSchema>
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
