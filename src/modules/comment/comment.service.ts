import mongoose from "mongoose"
import { Comment, CommentCounter, formatCommentId, type CommentStatus, type IComment } from "./comment.model.js"
import { resolveAnchor } from "./comment.anchor.js"
import type { CreateCommentDTO } from "./comment.validation.js"
import { getDocument, NoWorkingDraftError } from "../render/assemble.service.js"
import * as spineRepository from "../spine/spine.repository.js"
import { Membership, type OrgRole } from "../organization/membership.model.js"
import { User } from "../user/user.model.js"
import { notify } from "../notification/notification.service.js"
import { ApiError } from "../../shared/utils/api-error.js"

/** Người đang thao tác: project đã qua kiểm quyền org, vai trò lấy từ `orgContext`. */
export interface CommentActor {
  projectId: string
  projectName: string
  orgId: string
  userId: string
  role: OrgRole
}

export interface CommentPerson {
  _id: string
  name: string | null
  email: string | null
}

export interface CommentReplyDto {
  author: CommentPerson
  author_role: OrgRole
  text: string
  at: string
}

export interface CommentDto {
  comment_id: string
  version: { source: "draft" | "baseline"; baseline_id: string | null; label: string }
  anchor: { section_id: string; block_index: number | null; label: string; excerpt: string | null }
  author: CommentPerson
  author_role: OrgRole
  text: string
  status: CommentStatus
  cr_id: string | null
  handled_by: CommentPerson | null
  handled_at: string | null
  replies: CommentReplyDto[]
  created_at: string
}

const notFound = (): ApiError => new ApiError(404, "Không tìm thấy comment.", "COMMENT_NOT_FOUND")

// ─── phiên bản đang đọc ─────────────────────────────────────────

interface ResolvedVersion {
  source: "draft" | "baseline"
  baseline_id: string | null
  label: string
}

/** Baseline theo `id` (`BLnnn`) hoặc `snapshot_ref`; bỏ trống ⇒ mới nhất. Lưu `snapshot_ref` để đọc lại đúng bản. */
const resolveVersion = async (projectId: string, input: CreateCommentDTO["version"]): Promise<ResolvedVersion> => {
  if (input.source === "draft") return { source: "draft", baseline_id: null, label: "draft" }
  const record = await spineRepository.get(projectId)
  const baselines = record?.baselines ?? []
  const baseline = input.baseline_id
    ? baselines.find((b) => b.id === input.baseline_id || b.snapshot_ref === input.baseline_id)
    : baselines[baselines.length - 1]
  if (!baseline) throw new ApiError(404, "Không tìm thấy bản baseline này.", "BASELINE_NOT_FOUND")
  return { source: "baseline", baseline_id: baseline.snapshot_ref, label: baseline.version }
}

// ─── đọc ────────────────────────────────────────────────────────

const toPerson = (id: mongoose.Types.ObjectId | null, people: Map<string, CommentPerson>): CommentPerson | null => {
  if (!id) return null
  return people.get(String(id)) ?? { _id: String(id), name: null, email: null }
}

/** Nạp tên người viết của cả lô một lần — tránh populate từng reply. */
const loadPeople = async (comments: readonly IComment[]): Promise<Map<string, CommentPerson>> => {
  const ids = new Set<string>()
  for (const c of comments) {
    ids.add(String(c.author_id))
    if (c.handled_by) ids.add(String(c.handled_by))
    for (const r of c.replies) ids.add(String(r.author_id))
  }
  const users = await User.find({ _id: { $in: [...ids] } }).select("name email").lean()
  return new Map(users.map((u) => [String(u._id), { _id: String(u._id), name: u.name ?? null, email: u.email ?? null }]))
}

const toDto = (c: IComment, people: Map<string, CommentPerson>): CommentDto => ({
  comment_id: c.comment_id,
  version: { source: c.version.source, baseline_id: c.version.baseline_id ?? null, label: c.version.label },
  anchor: {
    section_id: c.anchor.section_id,
    block_index: c.anchor.block_index ?? null,
    label: c.anchor.label,
    excerpt: c.anchor.excerpt ?? null
  },
  author: toPerson(c.author_id, people) as CommentPerson,
  author_role: c.author_role,
  text: c.text,
  status: c.status,
  cr_id: c.cr_id ?? null,
  handled_by: toPerson(c.handled_by ?? null, people),
  handled_at: c.handled_at ? c.handled_at.toISOString() : null,
  replies: c.replies.map((r) => ({
    author: toPerson(r.author_id, people) as CommentPerson,
    author_role: r.author_role,
    text: r.text,
    at: r.at.toISOString()
  })),
  created_at: c.createdAt.toISOString()
})

export const toDtos = async (comments: readonly IComment[]): Promise<CommentDto[]> => {
  const people = await loadPeople(comments)
  return comments.map((c) => toDto(c, people))
}

/** Cũ trước — đọc như một luồng thảo luận. `open` (mặc định) ẩn comment đã xử lý / đã chuyển CR. */
export const listComments = async (projectId: string, status: "open" | "all"): Promise<CommentDto[]> => {
  const comments = await Comment.find(status === "open" ? { projectId, status: "open" as const } : { projectId }).sort({ createdAt: 1 })
  return toDtos(comments)
}

export const requireComment = async (projectId: string, commentId: string): Promise<IComment> => {
  const comment = await Comment.findOne({ projectId, comment_id: commentId })
  if (!comment) throw notFound()
  return comment
}

// ─── ghi ────────────────────────────────────────────────────────

/** Báo in-app cho Analyst/Lead của org (BR-31: chỉ in-app), trừ chính người viết. Lỗi không làm hỏng luồng chính. */
const notifyHandlers = async (actor: CommentActor, comment: IComment): Promise<void> => {
  const handlers = await Membership.find({
    organizationId: actor.orgId,
    role: { $in: ["lead", "analyst"] },
    userId: { $ne: actor.userId }
  })
    .select("userId")
    .lean()
  await Promise.all(
    handlers.map((m) =>
      notify(String(m.userId), {
        type: "comment_posted",
        title: `Comment mới ở ${actor.projectName}`,
        body: `${comment.comment_id} trên "${comment.anchor.label}" (${comment.version.label}): ${comment.text.slice(0, 200)}`,
        link: `/projects/${actor.projectId}/view?comment=${comment.comment_id}`,
        organizationId: actor.orgId,
        meta: { projectId: actor.projectId, comment_id: comment.comment_id }
      })
    )
  )
}

export const createComment = async (actor: CommentActor, input: CreateCommentDTO): Promise<CommentDto> => {
  // BR-27: Viewer chỉ comment trên bản đã phát hành — chặn trước khi tốn công dựng tài liệu.
  if (actor.role === "viewer" && input.version.source !== "baseline") {
    throw new ApiError(403, "Viewer chỉ comment được trên phiên bản đã phát hành.", "COMMENT_VERSION_FORBIDDEN")
  }
  const version = await resolveVersion(actor.projectId, input.version)
  // Project chưa có Spine ⇒ không có nội dung nào để ghim (cùng thông báo với chỗ ghim không tồn tại).
  const doc = await getDocument(actor.projectId, actor.projectName, {
    source: version.source,
    ...(version.baseline_id ? { baseline_id: version.baseline_id } : {})
  }).catch((err: unknown) => {
    if (err instanceof NoWorkingDraftError) return null
    throw err
  })
  const anchor = doc ? resolveAnchor(doc, input.anchor.section_id, input.anchor.block_index) : null
  if (!anchor) throw new ApiError(422, "Nội dung được ghim không tồn tại trong phiên bản này.", "COMMENT_ANCHOR_NOT_FOUND")

  const counter = await CommentCounter.findOneAndUpdate(
    { projectId: actor.projectId },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after" }
  )
  const comment = await Comment.create({
    projectId: actor.projectId,
    organizationId: actor.orgId,
    comment_id: formatCommentId(counter.seq),
    version,
    anchor,
    author_id: actor.userId,
    author_role: actor.role,
    text: input.text,
    status: "open"
  })
  await notifyHandlers(actor, comment)
  const [dto] = await toDtos([comment])
  return dto
}

/** Người đang theo một comment: tác giả + ai đã trả lời, trừ chính người vừa thao tác. */
const commentFollowers = (comment: IComment, actorId: string): string[] =>
  [...new Set([String(comment.author_id), ...comment.replies.map((r) => String(r.author_id))])].filter((id) => id !== actorId)

export const replyComment = async (actor: CommentActor, commentId: string, text: string): Promise<CommentDto> => {
  const comment = await requireComment(actor.projectId, commentId)
  // Lấy người theo dõi TRƯỚC khi thêm trả lời mới — người vừa trả lời không tự báo cho mình
  const followers = commentFollowers(comment, actor.userId)
  comment.replies.push({ author_id: new mongoose.Types.ObjectId(actor.userId), author_role: actor.role, text, at: new Date() })
  await comment.save()
  await Promise.all(
    followers.map((userId) =>
      notify(userId, {
        type: "comment_replied",
        title: `Trả lời mới ở ${comment.comment_id}`,
        body: `Trên "${comment.anchor.label}" (${actor.projectName}): ${text.slice(0, 200)}`,
        link: `/projects/${actor.projectId}/view?comment=${comment.comment_id}`,
        organizationId: actor.orgId,
        meta: { projectId: actor.projectId, comment_id: comment.comment_id }
      })
    )
  )
  const [dto] = await toDtos([comment])
  return dto
}

const notOpen = (comment: IComment): ApiError =>
  new ApiError(
    409,
    comment.status === "converted" ? `Comment đã được chuyển thành ${comment.cr_id}.` : "Comment đã được xử lý.",
    "COMMENT_NOT_OPEN"
  )

/** "Resolve": Analyst/Lead đánh dấu đã xử lý mà không đổi gì (role kiểm ở route); báo tác giả comment. */
export const resolveComment = async (actor: CommentActor, commentId: string): Promise<CommentDto> => {
  const updated = await Comment.findOneAndUpdate(
    { projectId: actor.projectId, comment_id: commentId, status: "open" },
    { $set: { status: "resolved", handled_by: actor.userId, handled_at: new Date() } },
    { returnDocument: "after" }
  )
  if (!updated) throw notOpen(await requireComment(actor.projectId, commentId))
  if (String(updated.author_id) !== actor.userId) {
    await notify(String(updated.author_id), {
      type: "comment_resolved",
      title: `Comment ${updated.comment_id} đã được xử lý`,
      body: `Góp ý của bạn trên "${updated.anchor.label}" (${actor.projectName}) đã được đánh dấu đã xử lý.`,
      link: `/projects/${actor.projectId}/view?comment=${updated.comment_id}`,
      organizationId: actor.orgId,
      meta: { projectId: actor.projectId, comment_id: updated.comment_id }
    })
  }
  const [dto] = await toDtos([updated])
  return dto
}

// ─── chuyển thành change request (UC-49 → UC-41) ────────────────

/** Gọi TRƯỚC khi tạo CR: comment phải còn mở — comment đã xử lý / đã chuyển không chuyển lại được. */
export const assertConvertible = async (projectId: string, commentId: string): Promise<IComment> => {
  const comment = await requireComment(projectId, commentId)
  if (comment.status !== "open") throw notOpen(comment)
  return comment
}

/**
 * Gọi SAU khi CR đã tạo: comment thành `converted` kèm mã CR và báo tác giả comment. Hai người cùng chuyển một
 * comment ⇒ chỉ lượt đầu đổi được status; lượt sau trả `false` (CR của lượt sau vẫn còn, không xoá).
 */
export const markConverted = async (
  projectId: string,
  commentId: string,
  crId: string,
  userId: string,
  orgId: string
): Promise<boolean> => {
  const updated = await Comment.findOneAndUpdate(
    { projectId, comment_id: commentId, status: "open" },
    { $set: { status: "converted", cr_id: crId, handled_by: userId, handled_at: new Date() } },
    { returnDocument: "after" }
  )
  if (!updated) return false
  if (String(updated.author_id) !== userId) {
    await notify(String(updated.author_id), {
      type: "comment_converted",
      title: `Comment ${updated.comment_id} đã thành ${crId}`,
      body: `Góp ý của bạn trên "${updated.anchor.label}" đã được ghi nhận thành change request ${crId}.`,
      link: `/projects/${projectId}/view?comment=${updated.comment_id}`,
      organizationId: orgId,
      meta: { projectId, comment_id: updated.comment_id, cr_id: crId }
    })
  }
  return true
}
