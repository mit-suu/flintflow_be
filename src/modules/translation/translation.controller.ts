/**
 * translation.controller.ts
 * ─────────────────────────────────────────────────────────────────
 * GET  /projects/:projectId/translations/status   đếm + ước tính phần chưa dịch (mọi vai trò, không gọi model)
 * POST /projects/:projectId/translations/run      dịch tối đa `max_batches` lô phần thiếu (Lead / Analyst)
 * Hợp đồng: docs/api/pipeline-contract.md #26, #27 (FLF-265).
 */

import { Request, Response } from "express"
import mongoose from "mongoose"
import { translationRunRequestSchema } from "../pipeline/pipeline.dto.js"
import { getProjectById } from "../project/project.service.js"
import type { IProject } from "../project/project.model.js"
import { requireOrgId } from "../../shared/auth/org-request.js"
import { sendSuccess } from "../../shared/types/api-response.js"
import { catchAsync } from "../../shared/utils/catch-async.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { validationError } from "../../shared/utils/validation-message.js"
import { translationStatus } from "./translation.service.js"
import { runTranslation } from "./translation-run.service.js"

interface Context {
  projectId: string
  userId: string
  project: IProject
}

const context = async (req: Request): Promise<Context> => {
  const userId = req.user?.userId
  if (!userId) throw new ApiError(401, "Bạn chưa đăng nhập hoặc phiên đăng nhập đã hết hạn.", "UNAUTHORIZED")

  const projectId = req.params.projectId as string
  if (!mongoose.isValidObjectId(projectId)) {
    throw new ApiError(404, "Không tìm thấy dự án hoặc bạn không có quyền truy cập.", "PROJECT_NOT_FOUND")
  }
  const project = await getProjectById(projectId, requireOrgId(req))
  return { projectId, userId, project }
}

export const getTranslationStatus = catchAsync(async (req: Request, res: Response) => {
  const { projectId, project } = await context(req)
  return sendSuccess(res, 200, await translationStatus(projectId, project))
})

// Quyền sở hữu kiểm trước khi validate body: người ngoài không dò được DTO qua lỗi 400
export const runTranslations = catchAsync(async (req: Request, res: Response) => {
  const { projectId, userId, project } = await context(req)
  const parsed = translationRunRequestSchema.safeParse(req.body ?? {})
  if (!parsed.success) throw validationError(parsed.error)
  return sendSuccess(res, 200, await runTranslation(projectId, userId, project, parsed.data))
})
