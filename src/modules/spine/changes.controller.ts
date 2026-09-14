/**
 * changes.controller.ts
 * ─────────────────────────────────────────────────────────────────
 * POST /projects/:projectId/changes          áp lô op thuần (T08); nhánh `instruction` là T17
 * POST /projects/:projectId/changes/preview  diff đầy đủ cascade, không ghi
 * Hợp đồng: docs/api/pipeline-contract.md, DTO: modules/pipeline/pipeline.dto.ts.
 */

import { Request, Response } from "express"
import mongoose from "mongoose"
import { z } from "zod"
import * as spineRepository from "./spine.repository.js"
import { TransactionRejectedError, applyTransaction, previewTransaction } from "./op-engine.js"
import type { Transaction } from "./op.types.js"
import { changesRequestSchema, type ChangesRequest } from "../pipeline/pipeline.dto.js"
import { getProjectById } from "../project/project.service.js"
import { sendError, sendSuccess } from "../../shared/types/api-response.js"
import { catchAsync } from "../../shared/utils/catch-async.js"
import { ApiError } from "../../shared/utils/api-error.js"

interface Authorized {
  projectId: string
  userId: string
  body: ChangesRequest & { ops: NonNullable<ChangesRequest["ops"]> }
}

const authorize = async (req: Request): Promise<Authorized> => {
  const userId = req.user?.userId
  if (!userId) throw new ApiError(401, "User not authenticated", "UNAUTHORIZED")

  const projectId = req.params.projectId as string
  if (!mongoose.isValidObjectId(projectId)) {
    throw new ApiError(404, "Project not found or unauthorized", "PROJECT_NOT_FOUND")
  }

  const parsed = changesRequestSchema.safeParse(req.body)
  if (!parsed.success) throw new ApiError(400, z.prettifyError(parsed.error), "VALIDATION_ERROR")
  const { ops } = parsed.data
  if (ops === undefined) {
    // TODO(T17): nhánh instruction đi qua skill apply-change-op
    throw new ApiError(501, "Sửa bằng câu lệnh (instruction) chưa được hỗ trợ", "NOT_IMPLEMENTED")
  }

  const project = await getProjectById(projectId, userId)
  // Project cũ chưa có Spine: tạo rỗng như GET /spine để lô đầu tiên có chỗ ghi
  await spineRepository.getOrCreate(projectId, { name: project.name, domain: project.domain ?? null })

  return { projectId, userId, body: { ...parsed.data, ops } }
}

const toTransaction = ({ userId, body }: Authorized): Transaction => ({
  base_version: body.base_version,
  ops: body.ops,
  by: userId,
  step_id: null,
  ...(body.reason === undefined ? {} : { reason: body.reason })
})

const sendRejected = (res: Response, err: TransactionRejectedError): Response =>
  sendError(res, err.statusCode, err.code, err.message, { violations: err.violations, referrers: err.referrers })

export const applyChanges = catchAsync(async (req: Request, res: Response) => {
  const auth = await authorize(req)
  try {
    const result = await applyTransaction(auth.projectId, toTransaction(auth))
    return sendSuccess(res, 200, {
      txn: result.txn,
      spine_version: result.spine_version,
      changes: result.changes,
      spine: result.spine
    })
  } catch (err) {
    if (err instanceof TransactionRejectedError) return sendRejected(res, err)
    throw err
  }
})

export const previewChanges = catchAsync(async (req: Request, res: Response) => {
  const auth = await authorize(req)
  const preview = await previewTransaction(auth.projectId, toTransaction(auth))
  return sendSuccess(res, 200, preview)
})
