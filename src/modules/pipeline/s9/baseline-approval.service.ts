/**
 * baseline-approval.service.ts
 * ─────────────────────────────────────────────────────────────────
 * UC-45 Analyst gửi SRS cho Lead duyệt · UC-46 luồng thay thế: Lead từ chối kèm lý do và comment ghim.
 *
 * Chốt baseline 1.0 là việc hai người: Analyst **nộp** ở đây, Lead **duyệt** ở `baseline.service.signOff`.
 * Việc của chính Lead thì tự duyệt, không qua bước nộp (UC-46 luồng chính).
 *
 * Trạng thái nộp nằm trên chính Spine (`baseline_submission`) nên đi qua đúng một đường ghi và được
 * khoá lạc quan bằng `base_version` như mọi lô khác. Lịch sử nộp/từ chối suy được từ `changes[]`.
 *
 * Điều kiện nộp giống hệt điều kiện duyệt (BR-04: cờ đỏ = 0) — cùng dùng `recheckAtBaseline`, để
 * Analyst không nộp được một bản mà Lead chắc chắn không ký được.
 */

import { Comment } from "../../comment/comment.model.js"
import { Membership } from "../../organization/membership.model.js"
import { notify } from "../../notification/notification.service.js"
import { applyTransaction } from "../../spine/op-engine.js"
import * as repository from "../../spine/spine.repository.js"
import type { BaselineSubmission, Spine } from "../../spine/spine.types.js"
import { ApiError } from "../../../shared/utils/api-error.js"
import { BaselineBlockedError, blockingFlags, recheckAtBaseline } from "./baseline.service.js"

/** Đã có bản đang chờ Lead quyết — nộp chồng lên là vô nghĩa. */
export const BASELINE_ALREADY_SUBMITTED = "BASELINE_ALREADY_SUBMITTED"
/** Từ chối khi không có bản nào đang chờ. */
export const NO_PENDING_SUBMISSION = "NO_PENDING_SUBMISSION"
/** Còn comment ghim của lần từ chối trước chưa xử lý (UC-47). `meta = { comment_ids[] }`. */
export const REJECTION_COMMENTS_OPEN = "REJECTION_COMMENTS_OPEN"

export interface ApprovalActor {
  projectId: string
  projectName: string
  orgId: string
  userId: string
}

export class RejectionCommentsOpenError extends ApiError {
  readonly commentIds: string[]

  constructor(commentIds: string[]) {
    super(
      422,
      `Còn ${commentIds.length} comment của lượt từ chối trước chưa xử lý — xử lý hết rồi gửi lại.`,
      REJECTION_COMMENTS_OPEN
    )
    this.commentIds = commentIds
  }
}

/**
 * Comment còn phải xử lý. `resolved` và `converted` đều tính là đã xử lý: `converted` nghĩa là
 * việc sửa đã được ghi nhận thành một change request.
 */
const openRejectionComments = async (projectId: string, commentIds: readonly string[]): Promise<string[]> => {
  if (commentIds.length === 0) return []
  const open = await Comment.find({ projectId, comment_id: { $in: commentIds }, status: "open" })
    .select("comment_id")
    .lean()
  return open.map((c) => c.comment_id)
}

/** Báo in-app cho mọi Lead của org, trừ chính người nộp (Lead tự nộp cho mình thì không cần báo). */
const notifyLeads = async (actor: ApprovalActor, submission: BaselineSubmission): Promise<void> => {
  const leads = await Membership.find({ organizationId: actor.orgId, role: "lead", userId: { $ne: actor.userId } })
    .select("userId")
    .lean()
  await Promise.all(
    leads.map((m) =>
      notify(String(m.userId), {
        type: "baseline_submitted",
        title: `${actor.projectName} chờ bạn duyệt baseline`,
        body: `Tài liệu đã qua kiểm tra, không còn cờ đỏ. Xem và duyệt để khoá baseline.`,
        link: `/projects/${actor.projectId}`,
        organizationId: actor.orgId,
        meta: { projectId: actor.projectId, spine_version: submission.spine_version }
      })
    )
  )
}

export interface SubmitResult {
  submission: BaselineSubmission
  spine_version: number
}

/**
 * UC-45 — nộp SRS cho Lead duyệt. Ném 422 `BASELINE_BLOCKED` khi còn cờ đỏ, 422 `REJECTION_COMMENTS_OPEN`
 * khi lượt từ chối trước còn comment chưa xử lý, 409 khi đã có bản đang chờ hoặc `base_version` lệch.
 */
export const submitForApproval = async (actor: ApprovalActor, baseVersion: number): Promise<SubmitResult> => {
  const { spine, checkedAtVersion } = await recheckAtBaseline(actor.projectId, actor.userId, baseVersion)

  const blocking = blockingFlags(spine)
  if (blocking.length > 0) throw new BaselineBlockedError(blocking)

  const current = spine.baseline_submission
  if (current?.status === "pending") {
    throw new ApiError(409, "Tài liệu đang chờ Lead duyệt — không gửi lại được.", BASELINE_ALREADY_SUBMITTED)
  }

  // Lượt nộp lại sau khi bị từ chối: mọi comment Lead đã ghim phải được xử lý trước (UC-47).
  const stillOpen = await openRejectionComments(actor.projectId, current?.rejection_comment_ids ?? [])
  if (stillOpen.length > 0) throw new RejectionCommentsOpenError(stillOpen)

  const submission: BaselineSubmission = {
    status: "pending",
    submitted_by: actor.userId,
    submitted_at: new Date().toISOString(),
    spine_version: checkedAtVersion,
    decided_by: null,
    decided_at: null,
    reason: null,
    rejection_comment_ids: []
  }

  const applied = await applyTransaction(actor.projectId, {
    base_version: checkedAtVersion,
    ops: [{ op: "set", path: "baseline_submission", value: submission, reason: "Gửi Lead duyệt baseline" }],
    by: actor.userId,
    step_id: null,
    reason: "Gửi duyệt baseline"
  })

  await notifyLeads(actor, submission)
  return { submission, spine_version: applied.spine_version }
}

export interface RejectInput {
  base_version: number
  reason: string
  comment_ids: string[]
}

/**
 * UC-46 luồng thay thế — Lead từ chối kèm lý do và các comment đã ghim vào nội dung. Baseline không
 * được ghi; Analyst xử lý từng comment (UC-47) rồi gửi lại.
 */
export const rejectSubmission = async (actor: ApprovalActor, input: RejectInput): Promise<SubmitResult> => {
  const record = await readSpineAt(actor.projectId, input.base_version)
  const current = record.baseline_submission
  if (current?.status !== "pending") {
    throw new ApiError(422, "Không có bản nào đang chờ duyệt.", NO_PENDING_SUBMISSION)
  }

  await assertCommentsBelongToProject(actor.projectId, input.comment_ids)

  const submission: BaselineSubmission = {
    ...current,
    status: "rejected",
    decided_by: actor.userId,
    decided_at: new Date().toISOString(),
    reason: input.reason,
    rejection_comment_ids: input.comment_ids
  }

  const applied = await applyTransaction(actor.projectId, {
    base_version: input.base_version,
    ops: [{ op: "set", path: "baseline_submission", value: submission, reason: "Từ chối baseline" }],
    by: actor.userId,
    step_id: null,
    reason: "Từ chối baseline"
  })

  if (current.submitted_by !== actor.userId) {
    void notify(current.submitted_by, {
      type: "baseline_rejected",
      title: `${actor.projectName}: Lead chưa duyệt baseline`,
      body: input.reason.slice(0, 300),
      link: `/projects/${actor.projectId}`,
      organizationId: actor.orgId,
      meta: { projectId: actor.projectId, comment_ids: input.comment_ids }
    })
  }

  return { submission, spine_version: applied.spine_version }
}

// ─── helper ──────────────────────────────────────────────────────

const readSpineAt = async (projectId: string, baseVersion: number): Promise<Spine> => {
  const record = await repository.get(projectId)
  if (!record) throw new ApiError(404, "Không tìm thấy dữ liệu tài liệu của dự án.", repository.SPINE_NOT_FOUND)
  if (record.spine_version !== baseVersion) {
    throw new ApiError(409, "Tài liệu vừa được thay đổi ở phiên khác. Vui lòng tải lại rồi thử lại.", repository.SPINE_VERSION_CONFLICT)
  }
  const { projectId: _projectId, ...spine } = record
  return spine
}

/** Comment ghim kèm lần từ chối phải là comment có thật của chính dự án này. */
const assertCommentsBelongToProject = async (projectId: string, commentIds: readonly string[]): Promise<void> => {
  if (commentIds.length === 0) return
  const found = await Comment.find({ projectId, comment_id: { $in: commentIds } })
    .select("comment_id")
    .lean()
  const missing = commentIds.filter((id) => !found.some((c) => c.comment_id === id))
  if (missing.length > 0) {
    throw new ApiError(422, `Comment không thuộc dự án này: ${missing.join(", ")}`, "VALIDATION_ERROR")
  }
}
