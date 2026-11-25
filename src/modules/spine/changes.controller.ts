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
import { User } from "../user/user.model.js"
import { z } from "zod"
import * as changeService from "./change.service.js"
import * as changeTranscript from "./change-transcript.js"
import { changeErrorReply } from "./change-transcript.js"
import * as reconcileService from "./reconcile.service.js"
import * as undoService from "./undo.service.js"
import { translateAssumption } from "./assumption-translate.service.js"
import { isViewer } from "../../shared/auth/viewer-read-scope.middleware.js"
import { viewerSpine } from "../../shared/auth/viewer-spine.js"
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
import type { IChatSession } from "../project/chat-session.model.js"
import { replyLanguageForSession } from "../project/reply-language.service.js"
import { accountLocaleOf } from "../user/account-locale.js"
import { requireOrgId } from "../../shared/auth/org-request.js"
import { sendError, sendSuccess } from "../../shared/types/api-response.js"
import { catchAsync } from "../../shared/utils/catch-async.js"
import { toClientError } from "../../shared/utils/client-error.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { validationError } from "../../shared/utils/validation-message.js"
import { byLanguage, detectMessageLanguage, resolveReplyLanguage, type ReplyLanguage } from "../../shared/i18n/reply-language.js"
import { changeRequiresCr, changesRequireCr, prefillFrom } from "../import/mode1-guard.js"
import * as commentService from "../comment/comment.service.js"

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

/**
 * Sau baseline mọi sửa qua change request (business-flow §3.2): mode 1 đã import xong (dự án tạo mới chuyển sang mode 1
 * ngay khi Lead ký).
 */
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

/**
 * FLF-260: ngôn ngữ trả lời của lượt sửa. Chỉ đoán trên câu lệnh user vừa gõ (`typed`); lô op sẵn hay bấm Áp dụng bản
 * xem trước (FE gửi lại câu lệnh cũ) thì không ⇒ ngôn ngữ phiên ⇒ tài khoản ⇒ tiếng Việt. Có phiên ⇒ ghi lên document
 * phiên, `recordChangeTurn` lưu cùng lượt.
 */
const turnReplyLanguage = async (session: IChatSession | null, typed: string | null | undefined, userId: string): Promise<ReplyLanguage> => {
  if (!session) return resolveReplyLanguage(detectMessageLanguage(typed, { lenient: true }), await accountLocaleOf(userId))
  const before = session.reply_language
  const language = await replyLanguageForSession(session, typed, userId)
  // Ghi ngay, không đợi `recordChangeTurn`: lượt gọi model sau đó có thể lỗi (không tới lượt ghi), và giữ document qua
  // vài giây chờ model thì lượt ghi muộn sẽ đè ngôn ngữ một request khác vừa đổi.
  if (session.reply_language !== before) await session.save()
  return language
}

/** FLF-299: số câu hỏi làm rõ đã hỏi cho yêu cầu đang dở — chỉ truyền khi có, lượt thường giữ nguyên tham số. */
const clarificationRoundsOf = (session: IChatSession | null): { clarification_rounds?: number; pending_request?: { request: string; question: string } } => {
  const rounds = session ? changeTranscript.clarificationRounds(session.messages) : 0
  if (!session || rounds === 0) return {}
  // P08 (T7): câu trả lời đi kèm yêu cầu gốc + câu đã hỏi
  const pending = changeTranscript.pendingChangeRequest(session.messages)
  return { clarification_rounds: rounds, ...(pending ? { pending_request: pending } : {}) }
}

export const applyChanges = catchAsync(async (req: Request, res: Response) => {
  const auth = await authorize(req)
  await guardMode1(auth, rawInstruction(req), "Sửa tài liệu")
  const body = parse(changesRequestSchema, req.body)
  const session = body.session_id ? await changeTranscript.loadProjectSession(auth.projectId, body.session_id) : null
  const chatHistory = session ? changeTranscript.formatChatContext(session.messages, await spineRepository.get(auth.projectId)) : undefined
  // Có preview_id ⇒ câu lệnh đã nằm trong phiên từ lượt xem trước; áp thẳng bằng instruction thì ghi cả câu lệnh
  const userText = body.preview_id === undefined ? (body.instruction ?? null) : null
  const replyLanguage = await turnReplyLanguage(session, userText, auth.userId)
  try {
    const result = await changeService.apply(
      auth.projectId,
      auth.userId,
      { ...body, chat_history: chatHistory, reply_language: replyLanguage, ...clarificationRoundsOf(session) },
      auth.init
    )
    // FLF-428: lệnh nhắm một cờ mà ghi xong cờ vẫn mở ⇒ nói rõ, không để "Đã áp dụng" đọc như đã sửa xong
    const unresolved = result.unresolved_flags ?? []
    const stillOpen =
      unresolved.length > 0
        ? byLanguage(replyLanguage, {
            vi: ` Nhưng vấn đề ${unresolved.map((f) => `"${f.message}"`).join(", ")} vẫn còn - bạn nhắn rõ giá trị cần điền (ví dụ chỉ số đo và ngưỡng) để tôi sửa tiếp.`,
            en: ` But the issue ${unresolved.map((f) => `"${f.message}"`).join(", ")} is still open - tell me the exact values (e.g. the metric and threshold) and I will fix it.`
          })
        : ""
    if (session) {
      const count = result.changes.length
      await changeTranscript.recordChangeTurn(session, userText, {
        kind: "change_applied",
        reply:
          (count > 0 && result.cr_id
            ? byLanguage(replyLanguage, {
                vi: `Đã ghi ${result.cr_id} vào tài liệu (${count} thay đổi).`,
                en: `Recorded ${result.cr_id} in the document (${count} change${count === 1 ? "" : "s"}).`
              })
            : count > 0
            ? byLanguage(replyLanguage, {
                vi: `Đã áp dụng ${count} thay đổi vào tài liệu.`,
                en: `Applied ${count} change${count === 1 ? "" : "s"} to the document.`
              })
            : result.already_applied?.length
            ? byLanguage(replyLanguage, {
                vi: `Đã được ${[...new Set(result.already_applied.map((p) => p.changed_by))].join(", ")} sửa giống đề xuất của bạn - không ghi lại.`,
                en: `${[...new Set(result.already_applied.map((p) => p.changed_by))].join(", ")} already made the same edit - nothing written again.`
              })
            : byLanguage(replyLanguage, { vi: "Đã xác nhận: nội dung không đổi.", en: "Confirmed: the content is unchanged." })) + stillOpen,
        count,
        spine_version: result.spine_version,
        ...(result.cr_id ? { cr_id: result.cr_id } : {}),
        // "Vẫn làm": người dùng áp dụng dù AI cảnh báo — giữ lời cảnh báo cho lượt kiểm sau đọc
        ...(result.kept_warning ? { kept_warning: result.kept_warning } : {}),
        // Lệnh nhiều ý: phần rõ đã ghi nhưng câu hỏi cho phần còn lại chưa được trả lời
        ...(result.request_open ? { request_open: true } : {})
      })
    }
    // FLF-271 (UC-40): sửa theo góp ý Lead ghim ⇒ góp ý tự đóng `fixed` khi có thay đổi thật; lỗi đóng không làm hỏng lượt áp
    const resolvedCommentId = body.comment_id && result.changes.length > 0 ? await resolveFixedComment(req, auth, body.comment_id) : null
    return sendSuccess(
      res,
      200,
      { txn: result.txn, spine_version: result.spine_version, changes: result.changes, spine: result.spine },
      {
        branch: result.branch,
        impact: result.impact,
        ...(result.cr_id ? { cr_id: result.cr_id } : {}),
        ...(resolvedCommentId ? { resolved_comment_id: resolvedCommentId } : {}),
        // P12 (BF §3.2): người khác đã sửa giống đề xuất ⇒ không ghi lại
        ...(result.already_applied?.length ? { already_applied: result.already_applied } : {})
      }
    )
  } catch (err) {
    // P12: đụng chỗ người khác vừa sửa ⇒ lượt này nằm lại trong phiên (màn so sánh hiện ở FE, câu báo ở transcript)
    if (session && err instanceof ApiError && Array.isArray(err.meta?.conflicts)) {
      await changeTranscript.recordChangeTurn(session, null, { kind: "change_error", reply: err.message })
    }
    return sendDomainError(res, err)
  }
})

/** Đóng comment `fixed` sau lượt áp (FLF-271). Comment đã xử lý / đã chuyển CR ⇒ bỏ qua; lỗi khác chỉ log. */
const resolveFixedComment = async (req: Request, auth: Authorized, commentId: string): Promise<string | null> => {
  const role = req.orgContext?.role
  if (!role) return null
  try {
    await commentService.resolveComment({ projectId: auth.projectId, projectName: auth.init.name ?? "", orgId: requireOrgId(req), userId: auth.userId, role }, commentId, { kind: "fixed", reason: null }, { reopenSteps: false })
    return commentId
  } catch (err) {
    if (err instanceof ApiError && err.code === "COMMENT_NOT_OPEN") return null
    console.warn("[changes] không đóng được comment sau lượt sửa:", err)
    return null
  }
}

export const previewChanges = catchAsync(async (req: Request, res: Response) => {
  const auth = await authorize(req)
  // Xem trước chỉ đọc ⇒ luôn chạy. Mode 1 sau v0: `meta.requires_cr` — bản xem trước dùng để soạn CR (3.1), không áp.
  const requiresCr = await mode1RequiresCr(auth)
  const body = parse(changesRequestSchema, req.body)
  const session = body.session_id ? await changeTranscript.loadProjectSession(auth.projectId, body.session_id) : null
  // Lượt ghi vào phiên chỉ khi có câu lệnh để đọc lại — lô op sẵn từ UI không phải một lượt hội thoại
  const userText = session ? (body.instruction ?? null) : null
  const chatHistory = session ? changeTranscript.formatChatContext(session.messages, await spineRepository.get(auth.projectId)) : undefined
  const replyLanguage = await turnReplyLanguage(session, body.instruction, auth.userId)
  let result: changeService.ChangePreviewResult
  try {
    // Lệnh gõ trong chat (không phải lô op sẵn của UI), trước baseline: mức duyệt cho phép thì tự ghi ngay sau xem trước
    const run = requiresCr || body.instruction === undefined || body.ops !== undefined ? changeService.preview : changeService.previewAndMaybeApply
    result = await run(
      auth.projectId,
      auth.userId,
      { ...body, chat_history: chatHistory, reply_language: replyLanguage, ...clarificationRoundsOf(session) },
      auth.init
    )
  } catch (err) {
    const payload = errorPayload(err)
    if (session && userText && payload) await changeTranscript.recordChangeTurn(session, userText, payload)
    return sendDomainError(res, err)
  }
  if (session && userText) await changeTranscript.recordChangeTurn(session, userText, changeTranscript.previewPayload(result, replyLanguage, { requiresCr }))
  // FLF-311: lựa chọn chỉ cho transcript (thẻ chọn trong chat) — hình response giữ đúng hợp đồng
  const { clarification_choices: _choices, auto_apply_ok: _auto, ...data } = result
  return requiresCr ? sendSuccess(res, 200, data, { requires_cr: true }) : sendSuccess(res, 200, data)
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
      {
        branch: result.branch,
        impact: result.impact,
        // P12 (chốt câu 9): mục bị người khác sửa đúng chữ giữa hai lượt — chưa ghi, FE gọi "Viết lại" lần nữa để AI soạn lại
        ...(result.redraft_sections?.length ? { redraft_sections: result.redraft_sections, skipped: result.skipped ?? [] } : {})
      }
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

/**
 * BF §3.2 (trước baseline): mục đang có bản xem trước sửa qua chat **chưa áp** của người khác ⇒ `[{ section_id, items:
 * [{ who }] }]`. FE in dưới tiêu đề mục: "<ai> có bản sửa chưa xác nhận ở mục này".
 */
export const listPendingPreviewSections = catchAsync(async (req: Request, res: Response) => {
  const auth = await authorize(req)
  const rows = changeService.pendingPreviewSections(auth.projectId, auth.userId)
  const ids = [...new Set(rows.flatMap((r) => r.user_ids))].filter((id) => mongoose.isValidObjectId(id))
  const users = ids.length ? await User.find({ _id: { $in: ids } }).select("name email").lean() : []
  const nameOf = new Map(users.map((u) => [String(u._id), u.name || u.email || null]))
  return sendSuccess(
    res,
    200,
    rows.map((r) => ({ section_id: r.section_id, items: r.user_ids.map((id) => ({ who: nameOf.get(id) ?? "Người khác" })) }))
  )
})

/** Người xem trước bấm Huỷ ⇒ bỏ bản xem trước (của chính mình; của người khác / hết hạn ⇒ không làm gì). */
export const discardPreview = catchAsync(async (req: Request, res: Response) => {
  const auth = await authorize(req)
  const discarded = changeService.discardPreview(auth.projectId, String(req.params.previewId), auth.userId)
  // P12 (BF §3.2 "Bỏ yêu cầu"): bỏ vì mục đã được người khác sửa ⇒ ghi lý do vào phiên chat (không gọi model, không tốn credit)
  const sessionId = typeof req.query.session_id === "string" ? req.query.session_id : null
  const note = typeof req.query.note === "string" ? req.query.note.trim().slice(0, 300) : ""
  if (discarded && sessionId && note) {
    const session = await changeTranscript.loadProjectSession(auth.projectId, sessionId)
    await changeTranscript.recordChangeTurn(session, null, { kind: "change_applied", reply: note, count: 0 })
  }
  return sendSuccess(res, 200, { discarded })
})

export const getTraceability = catchAsync(async (req: Request, res: Response) => {
  const auth = await authorize(req)
  const query = parse(traceabilityQuerySchema, req.query)
  // FLF-466: Viewer truy vết theo bản ổn định mới nhất
  if (isViewer(req)) return sendSuccess(res, 200, trace(await viewerSpine(auth.projectId), { entity: query.entity as TraceEntity, id: query.id }))
  const record = await spineRepository.get(auth.projectId)
  if (!record) throw new ApiError(404, "Không tìm thấy dữ liệu tài liệu của dự án.", spineRepository.SPINE_NOT_FOUND)
  const { projectId: _projectId, ...spine } = record
  return sendSuccess(res, 200, trace(spine, { entity: query.entity as TraceEntity, id: query.id }))
})
