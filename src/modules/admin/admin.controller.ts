import { Request, Response } from "express"
import * as adminService from "./admin.service.js"
import { sendSuccess } from "../../shared/types/api-response.js"
import { catchAsync } from "../../shared/utils/catch-async.js"
import {
  aiCostQuerySchema,
  parseWith,
  resolveDateRange,
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

export const getMetrics = catchAsync(async (_req: Request, res: Response) => {
  const metrics = await adminService.getMetrics()
  return sendSuccess(res, 200, metrics)
})

export const getAiCost = catchAsync(async (req: Request, res: Response) => {
  const query = parseWith(aiCostQuerySchema, req.query)
  const range = resolveDateRange(query)
  const report = await adminService.getAiCost(range, query.groupBy)
  return sendSuccess(res, 200, report)
})

export const listFeedback = catchAsync(async (_req: Request, res: Response) => {
  const items = await adminService.listFeedback()
  return sendSuccess(res, 200, items, { total: items.length })
})
