import { Request, Response } from "express"
import * as adminService from "./admin.service.js"
import { sendSuccess } from "../../shared/types/api-response.js"
import { catchAsync } from "../../shared/utils/catch-async.js"
import {
  adjustOrgCreditsSchema,
  aiCostQuerySchema,
  feedbackQuerySchema,
  logIdParamSchema,
  orgIdParamSchema,
  orgsQuerySchema,
  parseWith,
  resolveDateRange,
  setUserStatusSchema,
  userIdParamSchema,
  usersQuerySchema
} from "./admin.validation.js"

export const listUsers = catchAsync(async (req: Request, res: Response) => {
  const query = parseWith(usersQuerySchema, req.query)
  const result = await adminService.listUsers(query)
  return sendSuccess(res, 200, result.items, result.meta)
})

export const getUser = catchAsync(async (req: Request, res: Response) => {
  const { id } = parseWith(userIdParamSchema, req.params)
  const user = await adminService.getUserDetail(id)
  return sendSuccess(res, 200, user)
})

export const setUserStatus = catchAsync(async (req: Request, res: Response) => {
  const { id } = parseWith(userIdParamSchema, req.params)
  const input = parseWith(setUserStatusSchema, req.body)
  const result = await adminService.setUserStatus(String(req.user?.userId), id, input)
  return sendSuccess(res, 200, result)
})

export const getMetrics = catchAsync(async (_req: Request, res: Response) => {
  const metrics = await adminService.getMetrics()
  return sendSuccess(res, 200, metrics)
})

export const getAiCost = catchAsync(async (req: Request, res: Response) => {
  const query = parseWith(aiCostQuerySchema, req.query)
  const range = resolveDateRange(query)
  const report = await adminService.getAiCost(range, query.groupBy)
  // `totals` của báo cáo là trên toàn bộ nhóm; chỉ `rows` theo trang
  const { rows, meta } = adminService.paginateRows(report.rows, query.page, query.limit)
  return sendSuccess(res, 200, { ...report, rows }, meta)
})

export const getAiActionPayload = catchAsync(async (req: Request, res: Response) => {
  const { logId } = parseWith(logIdParamSchema, req.params)
  const payload = await adminService.getAiActionPayload(logId)
  return sendSuccess(res, 200, payload)
})

export const listFeedback = catchAsync(async (req: Request, res: Response) => {
  const query = parseWith(feedbackQuerySchema, req.query)
  const result = await adminService.listFeedback(query)
  return sendSuccess(res, 200, result.items, result.meta)
})

export const listOrgs = catchAsync(async (req: Request, res: Response) => {
  const query = parseWith(orgsQuerySchema, req.query)
  const result = await adminService.listOrgs(query)
  return sendSuccess(res, 200, result.items, result.meta)
})

export const adjustOrgCredits = catchAsync(async (req: Request, res: Response) => {
  const { orgId } = parseWith(orgIdParamSchema, req.params)
  const { amount, reason } = parseWith(adjustOrgCreditsSchema, req.body)
  const result = await adminService.adjustOrgCredits(orgId, amount, reason)
  return sendSuccess(res, 200, result)
})
