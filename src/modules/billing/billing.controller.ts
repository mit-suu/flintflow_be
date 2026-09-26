import { Request, Response } from "express"
import * as billingService from "./billing.service.js"
import { sendSuccess } from "../../shared/types/api-response.js"
import { catchAsync } from "../../shared/utils/catch-async.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { requireOrgId } from "../../shared/auth/org-request.js"
import {
  parseQuery,
  transactionsQuerySchema,
  CheckoutDTO,
  PaymentCallbackDTO,
  UpgradeDTO
} from "./billing.validation.js"
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
  const balance = await billingService.getBalance(requireOrgId(req), userId)
  return sendSuccess(res, 200, balance)
})

export const getPackages = catchAsync(async (_req: Request, res: Response) => {
  return sendSuccess(res, 200, billingService.listPackages())
})

export const createCheckout = catchAsync(async (req: Request, res: Response) => {
  const userId = requireUserId(req)
  const { packageId } = req.body as CheckoutDTO
  const checkout = await billingService.createCheckout(requireOrgId(req), userId, packageId)
  return sendSuccess(res, 201, checkout)
})

export const getCheckout = catchAsync(async (req: Request, res: Response) => {
  const userId = requireUserId(req)
  const checkout = await billingService.getCheckout(userId, req.params.intentId as string)
  return sendSuccess(res, 200, checkout)
})

export const paymentCallback = catchAsync(async (req: Request, res: Response) => {
  const result = await billingService.handlePaymentCallback(req.body as PaymentCallbackDTO)
  // Payment service chỉ cần 200 + { success: true } — trả nhanh, không bọc envelope
  return res.status(200).json(result)
})

export const upgradePlan = catchAsync(async (req: Request, res: Response) => {
  const userId = requireUserId(req)
  const { plan } = req.body as UpgradeDTO
  const subscription = await billingService.upgradePlan(requireOrgId(req), userId, plan as PlanId)
  return sendSuccess(res, 200, subscription)
})

export const getTransactions = catchAsync(async (req: Request, res: Response) => {
  const userId = requireUserId(req)
  const { page, limit } = parseQuery(transactionsQuerySchema, req.query)
  const result = await billingService.listTransactions(requireOrgId(req), page, limit)
  return sendSuccess(res, 200, result.items, result.meta)
})
