import { Request, Response } from "express"
import * as billingService from "./billing.service.js"
import { sendSuccess } from "../../shared/types/api-response.js"
import { catchAsync } from "../../shared/utils/catch-async.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { parseQuery, transactionsQuerySchema, CheckoutDTO, MockWebhookDTO, UpgradeDTO } from "./billing.validation.js"
import { PlanId } from "./plan.config.js"

const requireUserId = (req: Request): string => {
  const userId = req.user?.userId
  if (!userId) {
    throw new ApiError(401, "User not authenticated", "UNAUTHORIZED")
  }
  return userId
}

export const getBalance = catchAsync(async (req: Request, res: Response) => {
  const userId = requireUserId(req)
  const balance = await billingService.getBalance(userId)
  return sendSuccess(res, 200, balance)
})

export const getPackages = catchAsync(async (_req: Request, res: Response) => {
  return sendSuccess(res, 200, billingService.listPackages())
})

export const createCheckout = catchAsync(async (req: Request, res: Response) => {
  const userId = requireUserId(req)
  const { packageId } = req.body as CheckoutDTO
  const checkout = await billingService.createCheckout(userId, packageId)
  return sendSuccess(res, 201, checkout)
})

export const getCheckout = catchAsync(async (req: Request, res: Response) => {
  const userId = requireUserId(req)
  const checkout = await billingService.getCheckout(userId, req.params.intentId as string)
  return sendSuccess(res, 200, checkout)
})

export const mockWebhook = catchAsync(async (req: Request, res: Response) => {
  const { intentId, status, signature } = req.body as MockWebhookDTO
  const headerSignature = req.get("x-mock-signature")
  const result = await billingService.handleMockWebhook(
    intentId,
    status,
    headerSignature ?? signature
  )
  return sendSuccess(res, 200, result)
})

export const upgradePlan = catchAsync(async (req: Request, res: Response) => {
  const userId = requireUserId(req)
  const { plan } = req.body as UpgradeDTO
  const subscription = await billingService.upgradePlan(userId, plan as PlanId)
  return sendSuccess(res, 200, subscription)
})

export const getTransactions = catchAsync(async (req: Request, res: Response) => {
  const userId = requireUserId(req)
  const { page, limit } = parseQuery(transactionsQuerySchema, req.query)
  const result = await billingService.listTransactions(userId, page, limit)
  return sendSuccess(res, 200, result.items, result.meta)
})
