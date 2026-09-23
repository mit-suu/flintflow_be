/**
 * flags.controller.ts
 * ─────────────────────────────────────────────────────────────────
 * GET  /projects/:projectId/flags                   danh sách cờ (lọc level/open)
 * POST /projects/:projectId/flags/recompute         chạy lại deterministic check
 * POST /projects/:projectId/flags/:flagId/waive     waive cờ (lý do ≥ 20 ký tự)
 * GET  /projects/:projectId/progress                readiness + tiến độ step + status từng section
 * Hợp đồng: docs/api/pipeline-contract.md.
 */

import { Request, Response } from "express"
import mongoose from "mongoose"
import { z } from "zod"
import * as spineRepository from "./spine.repository.js"
import * as flagsService from "./flags.service.js"
import type { SpineRecord } from "./spine.types.js"
// `current_step` trong `progress` là step tới lượt theo step-registry (tính ở tầng pipeline, không phải con trỏ Spine)
import { buildPipelineProgressReport } from "../pipeline/pipeline-progress.js"
import { nextStep } from "../pipeline/step-registry.js"
import { flagsQuerySchema, recomputeFlagsRequestSchema, waiveRequestSchema } from "../pipeline/pipeline.dto.js"
import { getProjectById } from "../project/project.service.js"
import { sendSuccess } from "../../shared/types/api-response.js"
import { catchAsync } from "../../shared/utils/catch-async.js"
import { ApiError } from "../../shared/utils/api-error.js"

interface Context {
  projectId: string
  userId: string
  spine: SpineRecord
}

const context = async (req: Request): Promise<Context> => {
  const userId = req.user?.userId
  if (!userId) throw new ApiError(401, "User not authenticated", "UNAUTHORIZED")

  const projectId = req.params.projectId as string
  if (!mongoose.isValidObjectId(projectId)) {
    throw new ApiError(404, "Project not found or unauthorized", "PROJECT_NOT_FOUND")
  }
  const project = await getProjectById(projectId, userId)
  const spine = await spineRepository.getOrCreate(projectId, { name: project.name, domain: project.domain ?? null })
  return { projectId, userId, spine }
}

const parse = <T extends z.ZodType>(schema: T, input: unknown): z.infer<T> => {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new ApiError(400, z.prettifyError(parsed.error), "VALIDATION_ERROR")
  return parsed.data
}

// Quyền sở hữu kiểm trước khi validate query/body: người ngoài không dò được DTO qua lỗi 400
export const getFlags = catchAsync(async (req: Request, res: Response) => {
  const { spine } = await context(req)
  const query = parse(flagsQuerySchema, req.query)
  const flags = flagsService.filterFlags(spine.flags, {
    ...(query.level ? { level: query.level } : {}),
    ...(query.open ? { open: query.open === "true" } : {})
  })
  return sendSuccess(res, 200, flags)
})

export const recomputeFlags = catchAsync(async (req: Request, res: Response) => {
  const { projectId, userId, spine } = await context(req)
  const body = parse(recomputeFlagsRequestSchema, req.body ?? {})
  // Không nói rõ thì suy từ chỗ đang đứng: ở S-9 thì các luật baseline PHẢI chạy. Mặc định `false` ở đây
  // làm nút Recompute không bao giờ đóng được cờ `unconfirmed_assumption` — user xác nhận hết giả định mà
  // cờ đỏ vẫn y nguyên, không còn đường nào ngoài chạy lại S-9.1.
  const result = await flagsService.recompute(projectId, {
    atBaseline: body.at_baseline ?? (nextStep(spine)?.phase === "S-9"),
    by: userId
  })
  return sendSuccess(res, 200, result.flags, {
    checked_at_version: result.checked_at_version,
    opened: result.opened,
    resolved: result.resolved,
    reopened: result.reopened
  })
})

export const waiveFlag = catchAsync(async (req: Request, res: Response) => {
  const { projectId, userId } = await context(req)
  const body = parse(waiveRequestSchema, req.body)
  const flag = await flagsService.waive(projectId, req.params.flagId as string, body.reason, userId)
  return sendSuccess(res, 200, flag)
})

export const getProgress = catchAsync(async (req: Request, res: Response) => {
  const { projectId, spine } = await context(req)
  const changes = await spineRepository.listChanges(projectId)
  return sendSuccess(res, 200, buildPipelineProgressReport(spine, changes))
})
