import { Request, Response } from "express"
import * as specificationService from "./specification.service.js"
import { sendSuccess } from "../../shared/types/api-response.js"
import { catchAsync } from "../../shared/utils/catch-async.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { projectIdParamSchema } from "./specification.validation.js"

/**
 * UC34 - Xếp hạng tính năng theo mức ưu tiên (MoSCoW)
 * POST /api/v1/specifications/:projectId/generate-priority
 */
export const generatePriorityRanking = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId
  if (!userId) {
    throw new ApiError(401, "User not authenticated", "UNAUTHORIZED")
  }

  const { projectId } = projectIdParamSchema.parse(req.params)

  const result = await specificationService.generatePriorityRanking(projectId, userId)

  return sendSuccess(res, 200, result)
})

/**
 * UC35 - Sinh scope và out-of-scope
 * POST /api/v1/specifications/:projectId/generate-scope
 */
export const generateScopeOutOfScope = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId
  if (!userId) {
    throw new ApiError(401, "User not authenticated", "UNAUTHORIZED")
  }

  const { projectId } = projectIdParamSchema.parse(req.params)

  const result = await specificationService.generateScopeOutOfScope(projectId, userId)

  return sendSuccess(res, 200, result)
})
