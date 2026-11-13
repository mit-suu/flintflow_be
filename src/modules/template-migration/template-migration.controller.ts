import type { Request, Response } from "express"
import mongoose from "mongoose"
import { requireOrgId } from "../../shared/auth/org-request.js"
import { sendSuccess } from "../../shared/types/api-response.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { catchAsync } from "../../shared/utils/catch-async.js"
import { receiveDocx, requireFile } from "../import/import.controller.js"
import { parseInput } from "../import/mode1.http.js"
import { applyMigration } from "./apply.service.js"
import { restoreMigration, revertMigration } from "./revert.service.js"
import * as service from "./template-migration.service.js"
import { migrationIdSchema, patchDecisionsSchema, patchMappingSchema, patchPairsSchema, startFromFileSchema, startFromTemplateSchema } from "./template-migration.dto.js"

export { receiveDocx as receiveTemplateFile }

/** Dự án + org + người thao tác; vai trò đọc từ membership mỗi request (không từ token). `requireRole` ở route đã chặn Viewer. */
const contextOf = (req: Request): service.MigrationContext => {
  const projectId = String(req.params.id)
  if (!mongoose.isValidObjectId(projectId)) throw new ApiError(404, "Không tìm thấy dự án hoặc bạn không có quyền truy cập.", "PROJECT_NOT_FOUND")
  return { projectId, orgId: requireOrgId(req), actor: { userId: req.user!.userId, role: req.orgContext!.role } }
}

const migrationIdOf = (req: Request): string => {
  const parsed = migrationIdSchema.safeParse(req.params.migrationId)
  if (!parsed.success) throw new ApiError(404, "Không tìm thấy lần đổi mẫu này.", "TEMPLATE_MIGRATION_NOT_FOUND")
  return parsed.data
}

export const start = catchAsync(async (req: Request, res: Response) => {
  const ctx = contextOf(req)
  const input: service.StartInput = req.file
    ? { kind: "file", file: requireFile(req), ...parseInput(startFromFileSchema, req.body) }
    : { kind: "template", ...parseInput(startFromTemplateSchema, req.body) }
  return sendSuccess(res, 201, await service.startMigration(ctx, input))
})

export const list = catchAsync(async (req: Request, res: Response) => sendSuccess(res, 200, await service.listMigrations(contextOf(req))))

export const get = catchAsync(async (req: Request, res: Response) => sendSuccess(res, 200, await service.getMigration(contextOf(req), migrationIdOf(req))))

export const patchPairs = catchAsync(async (req: Request, res: Response) => {
  const body = parseInput(patchPairsSchema, req.body)
  return sendSuccess(res, 200, await service.patchPairs(contextOf(req), migrationIdOf(req), body.pairs))
})

export const patchMapping = catchAsync(async (req: Request, res: Response) => {
  const body = parseInput(patchMappingSchema, req.body)
  return sendSuccess(res, 200, await service.patchMapping(contextOf(req), migrationIdOf(req), body.edits))
})

export const confirmMapping = catchAsync(async (req: Request, res: Response) => sendSuccess(res, 200, await service.confirmMapping(contextOf(req), migrationIdOf(req))))

export const patchDecisions = catchAsync(async (req: Request, res: Response) => {
  const body = parseInput(patchDecisionsSchema, req.body)
  return sendSuccess(res, 200, await service.patchDecisions(contextOf(req), migrationIdOf(req), body))
})

export const ready = catchAsync(async (req: Request, res: Response) => sendSuccess(res, 200, await service.markReady(contextOf(req), migrationIdOf(req))))

/** Huỷ: lần áp dụng kẹt (`apply_failed`) không có gì "chưa làm" để huỷ — huỷ là khôi phục từ snapshot (đảo Spine + trả profile) rồi đóng. */
export const cancel = catchAsync(async (req: Request, res: Response) => {
  const ctx = contextOf(req)
  const id = migrationIdOf(req)
  const current = await service.load(ctx, id)
  return sendSuccess(res, 200, current.state === "apply_failed" ? await restoreMigration(ctx, id) : await service.cancelMigration(ctx, id))
})

export const apply = catchAsync(async (req: Request, res: Response) => sendSuccess(res, 200, await applyMigration(contextOf(req), migrationIdOf(req))))

export const restore = catchAsync(async (req: Request, res: Response) => sendSuccess(res, 200, await restoreMigration(contextOf(req), migrationIdOf(req))))

export const revert = catchAsync(async (req: Request, res: Response) => sendSuccess(res, 200, await revertMigration(contextOf(req), migrationIdOf(req))))
