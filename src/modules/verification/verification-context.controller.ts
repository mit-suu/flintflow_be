import { Request, Response } from "express"
import * as verificationContextService from "./verification-context.service.js"
import { sendSuccess } from "../../shared/types/api-response.js"
import { catchAsync } from "../../shared/utils/catch-async.js"
import { ApiError } from "../../shared/utils/api-error.js"

/**
 * GET /api/v1/verification/projects/:projectId
 * Lấy VerificationContext (Readiness score, status, và context nền tảng) của dự án.
 */
export const getVerificationContext = catchAsync(async (req: Request, res: Response) => {
  const projectId = req.params.projectId as string
  if (!projectId) {
    throw new ApiError(400, "Project ID is required", "PROJECT_ID_REQUIRED")
  }

  const context = await verificationContextService.getVerificationContext(projectId)
  return sendSuccess(res, 200, context)
})

/**
 * POST /api/v1/verification/projects/:projectId/recompute
 * Tính toán lại Readiness Score cơ bản cho dự án.
 */
export const recomputeReadiness = catchAsync(async (req: Request, res: Response) => {
  const projectId = req.params.projectId as string
  if (!projectId) {
    throw new ApiError(400, "Project ID is required", "PROJECT_ID_REQUIRED")
  }

  const result = await verificationContextService.computeBasicReadiness(projectId)
  return sendSuccess(res, 200, result)
})
