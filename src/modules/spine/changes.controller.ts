/**
 * changes.controller.ts
 * ─────────────────────────────────────────────────────────────────
 * Sáu endpoint của luồng sửa (hợp đồng `docs/api/pipeline-contract.md` §1, endpoint 7–11 và 15):
 *   POST /projects/:id/changes          áp lô — `ops` thuần (T08) hoặc `instruction` qua skill (T17)
 *   POST /projects/:id/changes/preview  diff đầy đủ cascade + phạm vi ảnh hưởng, không ghi
 *   POST /projects/:id/reconcile        hoà giải một lượt: lượt 1 preview gộp, lượt 2 áp
 *   POST /projects/:id/undo             hoàn tác lô gần nhất
 *   GET  /projects/:id/changes          lịch sử theo seq
 *   GET  /projects/:id/traceability     bản đồ liên kết read-only
 *
 * Controller chỉ: xác thực quyền sở hữu → parse DTO → gọi service → map lỗi sang envelope.
 * Nghiệp vụ nằm ở `change.service.ts`, `reconcile.service.ts`, `undo.service.ts`, `traceability.service.ts`.
 */

import { Request, Response } from "express"
import mongoose from "mongoose"
import { z } from "zod"
import * as changeService from "./change.service.js"
import * as reconcileService from "./reconcile.service.js"
import * as undoService from "./undo.service.js"
import * as spineRepository from "./spine.repository.js"
import { trace, type TraceEntity } from "./traceability.service.js"
import { TransactionRejectedError } from "./op-engine.js"
import {
  changesQuerySchema,
  changesRequestSchema,
  reconcileRequestSchema,
  traceabilityQuerySchema,
  undoRequestSchema
} from "../pipeline/pipeline.dto.js"
import { getProjectById } from "../project/project.service.js"
import { requireOrgId } from "../../shared/auth/org-request.js"
import { sendError, sendSuccess } from "../../shared/types/api-response.js"
import { catchAsync } from "../../shared/utils/catch-async.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { changeRequiresCr, changesRequireCr, prefillFrom } from "../import/mode1-guard.js"

export { SYSTEM_MANAGED_ROOTS, notWritableViolations } from "./change.service.js"

interface Authorized {
  projectId: string
  userId: string
  init: spineRepository.SpineInit
  /** FLF-171: project mode 1 không sửa Spine trực tiếp (G9, BR-03). */
  mode: string
}

/**
 * Kiểm quyền sở hữu TRƯỚC khi đọc body: người ngoài không dò được DTO qua lỗi 400.
 * Project không thuộc user trả 404 (không 403) — hợp đồng §0.
 */
const authorize = async (req: Request): Promise<Authorized> => {
  const userId = req.user?.userId
  if (!userId) throw new ApiError(401, "User not authenticated", "UNAUTHORIZED")

  const projectId = req.params.projectId as string
  if (!mongoose.isValidObjectId(projectId)) {
    throw new ApiError(404, "Project not found or unauthorized", "PROJECT_NOT_FOUND")
  }
  const project = await getProjectById(projectId, requireOrgId(req))
  return { projectId, userId, init: { name: project.name, domain: project.domain ?? null }, mode: project.mode ?? "fpt" }
}

const rawInstruction = (req: Request): string | undefined =>
  typeof req.body?.instruction === "string" ? req.body.instruction : undefined

/**
 * Mode 1: sau baseline v1 (sign-off) / release mọi sửa phải qua change request ⇒ 409 CHANGE_REQUIRES_CR kèm nội dung
 * điền sẵn (FLF-171, G9). Trước đó sửa tự do như mode 2 (mode 1 v2, D3 — FLF-183).
 */
const guardMode1 = async (auth: Authorized, instruction?: string): Promise<void> => {
  if (auth.mode === "import" && (await changesRequireCr(auth.projectId))) throw changeRequiresCr(prefillFrom(instruction))
}

const parse = <T extends z.ZodType>(schema: T, value: unknown): z.infer<T> => {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new ApiError(400, z.prettifyError(parsed.error), "VALIDATION_ERROR")
  return parsed.data
}

/** Lỗi có `meta` riêng theo hợp đồng §0.3 trả envelope tại chỗ; lỗi khác ném tiếp cho error handler chung. */
const sendDomainError = (res: Response, err: unknown): Response => {
  if (err instanceof TransactionRejectedError) {
    return sendError(res, err.statusCode, err.code, err.message, { violations: err.violations, referrers: err.referrers })
  }
  if (err instanceof changeService.NeedsClarificationError) {
    return sendError(res, err.statusCode, err.code, err.message, { clarification: err.clarification })
  }
  throw err
}

export const applyChanges = catchAsync(async (req: Request, res: Response) => {
  const auth = await authorize(req)
  await guardMode1(auth, rawInstruction(req))
  const body = parse(changesRequestSchema, req.body)
  try {
    const result = await changeService.apply(auth.projectId, auth.userId, body, auth.init)
    return sendSuccess(
      res,
      200,
      { txn: result.txn, spine_version: result.spine_version, changes: result.changes, spine: result.spine },
      { branch: result.branch, impact: result.impact }
    )
  } catch (err) {
    return sendDomainError(res, err)
  }
})

export const previewChanges = catchAsync(async (req: Request, res: Response) => {
  const auth = await authorize(req)
  await guardMode1(auth, rawInstruction(req))
  const body = parse(changesRequestSchema, req.body)
  try {
    return sendSuccess(res, 200, await changeService.preview(auth.projectId, auth.userId, body, auth.init))
  } catch (err) {
    return sendDomainError(res, err)
  }
})

export const reconcileChanges = catchAsync(async (req: Request, res: Response) => {
  const auth = await authorize(req)
  await guardMode1(auth, rawInstruction(req))
  const body = parse(reconcileRequestSchema, req.body)
  try {
    const result = await reconcileService.reconcile(auth.projectId, auth.userId, body, auth.init)
    if (!reconcileService.isReconcileApplied(result)) return sendSuccess(res, 200, result)
    return sendSuccess(
      res,
      200,
      { txn: result.txn, spine_version: result.spine_version, changes: result.changes, spine: result.spine },
      { branch: result.branch, impact: result.impact }
    )
  } catch (err) {
    return sendDomainError(res, err)
  }
})

export const undoLastChange = catchAsync(async (req: Request, res: Response) => {
  const auth = await authorize(req)
  await guardMode1(auth, rawInstruction(req))
  const body = parse(undoRequestSchema, req.body)
  try {
    const result = await undoService.undoLast(auth.projectId, auth.userId, { base_version: body.base_version })
    return sendSuccess(res, 200, {
      txn: result.txn,
      spine_version: result.spine_version,
      changes: result.changes,
      spine: result.spine
    })
  } catch (err) {
    return sendDomainError(res, err)
  }
})

export const listChanges = catchAsync(async (req: Request, res: Response) => {
  const auth = await authorize(req)
  const query = parse(changesQuerySchema, req.query)
  const changes = await spineRepository.listChanges(auth.projectId, {
    ...(query.from === undefined ? {} : { fromSeq: query.from }),
    ...(query.to === undefined ? {} : { toSeq: query.to })
  })
  return sendSuccess(res, 200, changes)
})

export const getTraceability = catchAsync(async (req: Request, res: Response) => {
  const auth = await authorize(req)
  const query = parse(traceabilityQuerySchema, req.query)
  const record = await spineRepository.get(auth.projectId)
  if (!record) throw new ApiError(404, "Không tìm thấy Spine của dự án", spineRepository.SPINE_NOT_FOUND)
  const { projectId: _projectId, ...spine } = record
  return sendSuccess(res, 200, trace(spine, { entity: query.entity as TraceEntity, id: query.id }))
})
