/**
 * baseline.controller.ts
 * ─────────────────────────────────────────────────────────────────
 * Endpoint 19 và 20 của `docs/api/pipeline-contract.md`:
 *   POST /projects/:id/baseline   ký baseline (S-9.5)
 *   GET  /projects/:id/baselines  danh sách mốc đã ký
 *
 * Bản sạch của một baseline đọc qua endpoint 16 đã có sẵn:
 * `GET /projects/:id/document?source=baseline&baseline_id=<id>` (T15) — không thêm alias mới để khỏi
 * mở endpoint ngoài hợp đồng.
 */

import { Request, Response } from "express"
import mongoose from "mongoose"
import { z } from "zod"
import * as baselineService from "./baseline.service.js"
import { baselineRequestSchema } from "../pipeline.dto.js"
import { getProjectById } from "../../project/project.service.js"
import { requireOrgId } from "../../../shared/auth/org-request.js"
import { sendError, sendSuccess } from "../../../shared/types/api-response.js"
import { catchAsync } from "../../../shared/utils/catch-async.js"
import { ApiError } from "../../../shared/utils/api-error.js"
import { assertNotMode1 } from "../../import/mode1-guard.js"

interface Authorized {
  projectId: string
  userId: string
  mode: string
}

/** Kiểm quyền sở hữu trước khi đọc body; project không thuộc user trả 404, không 403 (hợp đồng §0). */
const authorize = async (req: Request): Promise<Authorized> => {
  const userId = req.user?.userId
  if (!userId) throw new ApiError(401, "User not authenticated", "UNAUTHORIZED")

  const projectId = req.params.projectId as string
  if (!mongoose.isValidObjectId(projectId)) {
    throw new ApiError(404, "Project not found or unauthorized", "PROJECT_NOT_FOUND")
  }
  const project = await getProjectById(projectId, requireOrgId(req))
  return { projectId, userId, mode: project.mode ?? "fpt" }
}

export const createBaseline = catchAsync(async (req: Request, res: Response) => {
  const auth = await authorize(req)
  assertNotMode1(auth.mode, "signoff") // mode 1 v3: khoá duy nhất sau v0 là release (Flow 6)
  const parsed = baselineRequestSchema.safeParse(req.body)
  if (!parsed.success) throw new ApiError(400, z.prettifyError(parsed.error), "VALIDATION_ERROR")

  try {
    const result = await baselineService.signOff(auth.projectId, auth.userId, { base_version: parsed.data.base_version })
    return sendSuccess(res, 201, result.baseline, {
      spine_version: result.spine_version,
      waived: result.waived.map(({ id, rule_id, section_id, waive_reason }) => ({ id, rule_id, section_id, waive_reason }))
    })
  } catch (err) {
    if (err instanceof baselineService.BaselineBlockedError) {
      return sendError(res, err.statusCode, err.code, err.message, {
        flags: err.flags.map(({ id, rule_id, section_id, target_id, message, remediation_step }) => ({
          id,
          rule_id,
          section_id,
          target_id,
          message,
          remediation_step
        }))
      })
    }
    throw err
  }
})

export const listBaselines = catchAsync(async (req: Request, res: Response) => {
  const auth = await authorize(req)
  return sendSuccess(res, 200, await baselineService.listBaselines(auth.projectId))
})
