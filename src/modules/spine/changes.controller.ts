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
 *   PATCH /projects/:id/assumptions/:assumptionId  sửa giả định bằng ngôn ngữ user, AI dịch EN (FLF-221)
 *
 * Controller chỉ: xác thực quyền sở hữu → parse DTO → gọi service → map lỗi sang envelope.
 * Nghiệp vụ nằm ở `change.service.ts`, `reconcile.service.ts`, `undo.service.ts`, `traceability.service.ts`.
 */

import { Request, Response } from "express"
import mongoose from "mongoose"
import { z } from "zod"
import * as changeService from "./change.service.js"
import * as changeTranscript from "./change-transcript.js"
import { changeErrorReply } from "./change-transcript.js"
import * as reconcileService from "./reconcile.service.js"
import * as undoService from "./undo.service.js"
import { translateAssumption } from "./assumption-translate.service.js"
import * as spineRepository from "./spine.repository.js"
import { trace, type TraceEntity } from "./traceability.service.js"
import { TransactionRejectedError } from "./op-engine.js"
import {
  assumptionEditRequestSchema,
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
import { toClientError } from "../../shared/utils/client-error.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { validationError } from "../../shared/utils/validation-message.js"
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
  if (!userId) throw new ApiError(401, "Bạn chưa đăng nhập hoặc phiên đăng nhập đã hết hạn.", "UNAUTHORIZED")

  const projectId = req.params.projectId as string
  if (!mongoose.isValidObjectId(projectId)) {
    throw new ApiError(404, "Không tìm thấy dự án hoặc bạn không có quyền truy cập.", "PROJECT_NOT_FOUND")
  }
  const project = await getProjectById(projectId, requireOrgId(req))
  return { projectId, userId, init: { name: project.name, domain: project.domain ?? null }, mode: project.mode ?? "fpt" }
}

const rawInstruction = (req: Request): string | undefined =>
  typeof req.body?.instruction === "string" ? req.body.instruction : undefined

/** Mode 1 đã import xong (mode 1 v3, BPMN Flow 1 ⇒ 3.1): mọi sửa phải qua change request. */
const mode1RequiresCr = async (auth: Authorized): Promise<boolean> => auth.mode === "import" && (await changesRequireCr(auth.projectId))

/**
 * Lời gọi **có ghi** (`/changes`, `/reconcile`, `/undo`) ở mode 1 sau v0 ⇒ `409 CHANGE_REQUIRES_CR` kèm nội dung
 * điền sẵn cho form 3.1. Không tự tạo CR (3.1 là việc của BA: nguồn + người yêu cầu bắt buộc).
 */
const guardMode1 = async (auth: Authorized, instruction: string | undefined, fallback: string): Promise<void> => {
  if (await mode1RequiresCr(auth)) throw changeRequiresCr(prefillFrom(instruction, fallback, { kind: "verbal", ref: null }))
}

const parse = <T extends z.ZodType>(schema: T, value: unknown): z.infer<T> => {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw validationError(parsed.error)
  return parsed.data
}

/** Lỗi có `meta` riêng theo hợp đồng §0.3 trả envelope tại chỗ; lỗi khác ném tiếp cho error handler chung. */
const sendDomainError = (res: Response, err: unknown): Response => {
  if (err instanceof TransactionRejectedError) {
    // Câu theo luật vi phạm (không path op); path/luật nằm ở meta.violations — FLF-247
    const client = toClientError(err)
    return sendError(res, client.status, client.code, client.message, { violations: err.violations, referrers: err.referrers })
  }
  if (err instanceof changeService.NeedsClarificationError) {
    return sendError(res, err.statusCode, err.code, err.message, { clarification: err.clarification })
  }
  throw err
}

/** Lỗi nghiệp vụ của lượt sửa ⇒ tin `change_error` trong phiên, để transcript không cụt ở câu lệnh của user. */
const errorPayload = (err: unknown): Record<string, unknown> | null =>
  err instanceof ApiError ? { kind: "change_error", reply: changeErrorReply(err) } : null

export const applyChanges = catchAsync(async (req: Request, res: Response) => {
  const auth = await authorize(req)
  await guardMode1(auth, rawInstruction(req), "Sửa tài liệu")
  const body = parse(changesRequestSchema, req.body)
  const session = body.session_id ? await changeTranscript.loadProjectSession(auth.projectId, body.session_id) : null
  const chatHistory = session ? changeTranscript.formatChatContext(session.messages, await spineRepository.get(auth.projectId)) : undefined
  try {
    const result = await changeService.apply(auth.projectId, auth.userId, { ...body, chat_history: chatHistory }, auth.init)
    if (session) {
      // Có preview_id ⇒ câu lệnh đã nằm trong phiên từ lượt xem trước; áp thẳng bằng instruction thì ghi cả câu lệnh
      const userText = body.preview_id === undefined ? (body.instruction ?? null) : null
      const count = result.changes.length
      await changeTranscript.recordChangeTurn(session, userText, {
        kind: "change_applied",
        reply: count > 0 ? `Đã áp dụng ${count} thay đổi vào tài liệu (v${result.spine_version}).` : "Đã xác nhận: nội dung không đổi.",
        count,
        spine_version: result.spine_version
      })
    }
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
  // Xem trước chỉ đọc ⇒ luôn chạy. Mode 1 sau v0: `meta.requires_cr` — bản xem trước dùng để soạn CR (3.1), không áp.
  const requiresCr = await mode1RequiresCr(auth)
  const body = parse(changesRequestSchema, req.body)
  const session = body.session_id ? await changeTranscript.loadProjectSession(auth.projectId, body.session_id) : null
  // Lượt ghi vào phiên chỉ khi có câu lệnh để đọc lại — lô op sẵn từ UI không phải một lượt hội thoại
  const userText = session ? (body.instruction ?? null) : null
  const chatHistory = session ? changeTranscript.formatChatContext(session.messages, await spineRepository.get(auth.projectId)) : undefined
  let result: changeService.ChangePreviewResult
  try {
    result = await changeService.preview(auth.projectId, auth.userId, { ...body, chat_history: chatHistory }, auth.init)
  } catch (err) {
    const payload = errorPayload(err)
    if (session && userText && payload) await changeTranscript.recordChangeTurn(session, userText, payload)
    return sendDomainError(res, err)
  }
  if (session && userText) await changeTranscript.recordChangeTurn(session, userText, changeTranscript.previewPayload(result))
  return requiresCr ? sendSuccess(res, 200, result, { requires_cr: true }) : sendSuccess(res, 200, result)
})

export const reconcileChanges = catchAsync(async (req: Request, res: Response) => {
  const auth = await authorize(req)
  await guardMode1(auth, rawInstruction(req), "Sửa tài liệu")
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

/** FLF-221: "Sửa" giả định — ghi `statement_vi` user gõ và `statement` EN do AI dịch trong một transaction. */
export const editAssumption = catchAsync(async (req: Request, res: Response) => {
  const auth = await authorize(req)
  await guardMode1(auth, undefined, "Sửa giả định")
  const body = parse(assumptionEditRequestSchema, req.body)
  try {
    const result = await translateAssumption(auth.projectId, req.params.assumptionId as string, auth.userId, body)
    return sendSuccess(res, 200, { spine_version: result.spine_version, spine: result.spine })
  } catch (err) {
    return sendDomainError(res, err)
  }
})

export const undoLastChange = catchAsync(async (req: Request, res: Response) => {
  const auth = await authorize(req)
  await guardMode1(auth, rawInstruction(req), "Hoàn tác thay đổi gần nhất")
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
  if (!record) throw new ApiError(404, "Không tìm thấy dữ liệu tài liệu của dự án.", spineRepository.SPINE_NOT_FOUND)
  const { projectId: _projectId, ...spine } = record
  return sendSuccess(res, 200, trace(spine, { entity: query.entity as TraceEntity, id: query.id }))
})
