/**
 * changes.controller.ts
 * ─────────────────────────────────────────────────────────────────
 * POST /projects/:projectId/changes          áp lô op thuần (T08); nhánh `instruction` là T17
 * POST /projects/:projectId/changes/preview  diff đầy đủ cascade, không ghi
 * Hợp đồng: docs/api/pipeline-contract.md, DTO: modules/pipeline/pipeline.dto.ts.
 */

import { randomUUID } from "node:crypto"
import { Request, Response } from "express"
import mongoose from "mongoose"
import { z } from "zod"
import * as spineRepository from "./spine.repository.js"
import { TransactionRejectedError, applyTransaction, previewTransaction } from "./op-engine.js"
import { OP_INVALID, type Op, type PreviewResult, type Transaction, type Violation } from "./op.types.js"
import { PathError, parsePath } from "./path-resolver.js"
import { changesRequestSchema, type ChangesRequest } from "../pipeline/pipeline.dto.js"
import { getProjectById } from "../project/project.service.js"
import { sendError, sendSuccess } from "../../shared/types/api-response.js"
import { catchAsync } from "../../shared/utils/catch-async.js"
import { ApiError } from "../../shared/utils/api-error.js"

/**
 * Gốc path do hệ thống quản lý — user không sửa trực tiếp qua `/changes`:
 * cờ đi qua `/flags` (waive/recompute), step/progress qua step runner và gate, baseline qua `/baseline`,
 * section và diagram do engine/render ghi.
 */
export const SYSTEM_MANAGED_ROOTS: ReadonlySet<string> = new Set(["flags", "steps", "progress", "baselines", "sections", "diagrams"])

export const notWritableViolations = (ops: readonly Op[]): Violation[] =>
  ops.flatMap((op, index): Violation[] => {
    let root: string
    try {
      root = parsePath(op.path)[0].key
    } catch (err) {
      // Path sai cú pháp: để engine báo path_invalid kèm op_index
      if (err instanceof PathError) return []
      throw err
    }
    if (!SYSTEM_MANAGED_ROOTS.has(root)) return []
    return [{ rule: "path_not_writable", path: op.path, op_index: index, message: `"${root}" do hệ thống quản lý, không sửa trực tiếp qua /changes` }]
  })

interface Authorized {
  projectId: string
  userId: string
  init: spineRepository.SpineInit
  body: ChangesRequest & { ops: NonNullable<ChangesRequest["ops"]> }
  violations: Violation[]
}

const authorize = async (req: Request): Promise<Authorized> => {
  const userId = req.user?.userId
  if (!userId) throw new ApiError(401, "User not authenticated", "UNAUTHORIZED")

  const projectId = req.params.projectId as string
  if (!mongoose.isValidObjectId(projectId)) {
    throw new ApiError(404, "Project not found or unauthorized", "PROJECT_NOT_FOUND")
  }
  // Kiểm quyền sở hữu trước khi đọc body: người ngoài không dò được DTO qua lỗi 400
  const project = await getProjectById(projectId, userId)

  const parsed = changesRequestSchema.safeParse(req.body)
  if (!parsed.success) throw new ApiError(400, z.prettifyError(parsed.error), "VALIDATION_ERROR")
  const { ops } = parsed.data
  if (ops === undefined) {
    // TODO(T17): nhánh instruction đi qua skill apply-change-op
    throw new ApiError(501, "Sửa bằng câu lệnh (instruction) chưa được hỗ trợ", "NOT_IMPLEMENTED")
  }

  return {
    projectId,
    userId,
    init: { name: project.name, domain: project.domain ?? null },
    body: { ...parsed.data, ops },
    violations: notWritableViolations(ops)
  }
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
    if (auth.violations.length > 0) throw new TransactionRejectedError(OP_INVALID, auth.violations)
    // Project cũ chưa có Spine: tạo rỗng như GET /spine để lô đầu tiên có chỗ ghi
    await spineRepository.getOrCreate(auth.projectId, auth.init)
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
  const txn = toTransaction(auth)
  if (auth.violations.length > 0) {
    const rejected: PreviewResult = {
      ok: false,
      txn: randomUUID(),
      base_version: txn.base_version,
      ops: [],
      changes: [],
      violations: auth.violations,
      referrers: []
    }
    return sendSuccess(res, 200, rejected)
  }
  const preview = await previewTransaction(auth.projectId, txn, auth.init)
  return sendSuccess(res, 200, preview)
})
