import mongoose, { Schema, Document } from "mongoose"
import { ORG_ROLES, type OrgRole } from "../organization/membership.model.js"

/**
 * Comment ghim vào nội dung SRS (UC-49, SRS v6 §3.9.3). Comment KHÔNG đổi nội dung (BR-05): sau baseline, Analyst
 * hoặc Lead chuyển nó thành change request nguồn "Viewer comment" (UC-41) — lúc đó status thành `converted`.
 */
export const COMMENT_STATUSES = ["open", "resolved", "converted"] as const
export type CommentStatus = (typeof COMMENT_STATUSES)[number]

/**
 * Hai nhánh kết luận một comment theo `business-flow.md §3.5` — *"chat yêu cầu AI sửa / giữ nguyên + lý do"*,
 * cùng lối với C-4 (*"mỗi chỗ phải có kết luận: sửa / chỉ comment / không liên quan + lý do"*).
 *
 * Tách hai nhánh vì Lead duyệt lại cần biết **vì sao** comment được đóng: một danh sách tick xanh không
 * nói được Analyst đã sửa thật hay chỉ bấm cho xong.
 */
export const COMMENT_RESOLUTIONS = ["fixed", "kept"] as const
export type CommentResolutionKind = (typeof COMMENT_RESOLUTIONS)[number]

/** Lý do bắt buộc khi giữ nguyên — đủ dài để là một câu giải thích, không phải "ok". */
export const KEEP_REASON_MIN_LENGTH = 10

export interface CommentResolution {
  kind: CommentResolutionKind
  /** Bắt buộc với `kept`; `null` với `fixed` (nội dung đã đổi, bản thân thay đổi là lời giải thích). */
  reason: string | null
}

export const COMMENT_TEXT_MAX = 2000
/** Đoạn trích nội dung đã ghim — đủ để người đọc nhận ra chỗ ghim khi nội dung ở bản sau đã khác. */
export const COMMENT_EXCERPT_MAX = 160
export const COMMENT_ID_PATTERN = /^CM-\d{3,}$/

export const formatCommentId = (seq: number): string => `CM-${String(seq).padStart(3, "0")}`

/** Phiên bản đang đọc khi viết comment: bản nháp, hoặc một baseline đã phát hành (BR-27: Viewer chỉ bản này). */
export interface CommentVersion {
  source: "draft" | "baseline"
  /** `snapshot_ref` của baseline; `null` với bản nháp. */
  baseline_id: string | null
  /** Nhãn hiển thị: `draft`, `v1.0`, `0.0`… */
  label: string
}

/** Chỗ ghim: một section của `RenderedDocument`, có thể thu hẹp tới một block trong section. */
export interface CommentAnchor {
  section_id: string
  /** Chỉ số block trong `section.blocks`; `null` = ghim cả section. */
  block_index: number | null
  /** Nhãn do server dựng từ bản đang đọc, vd `3.2.4 Cancel booking › Block 2`. */
  label: string
  excerpt: string | null
}

export interface CommentReply {
  author_id: mongoose.Types.ObjectId
  author_role: OrgRole
  text: string
  at: Date
}

export interface IComment extends Document {
  projectId: mongoose.Types.ObjectId
  organizationId: mongoose.Types.ObjectId
  comment_id: string
  version: CommentVersion
  anchor: CommentAnchor
  author_id: mongoose.Types.ObjectId
  author_role: OrgRole
  text: string
  status: CommentStatus
  cr_id: string | null
  handled_by: mongoose.Types.ObjectId | null
  handled_at: Date | null
  /** Kết luận của lượt resolve (§3.5); `null` khi chưa xử lý hoặc đã chuyển thành CR. */
  resolution: CommentResolution | null
  replies: CommentReply[]
  createdAt: Date
  updatedAt: Date
}

const replySchema = new Schema<CommentReply>(
  {
    author_id: { type: Schema.Types.ObjectId, ref: "User", required: true },
    author_role: { type: String, enum: ORG_ROLES, required: true },
    text: { type: String, required: true, trim: true, maxlength: COMMENT_TEXT_MAX },
    at: { type: Date, required: true }
  },
  { _id: false }
)

const commentSchema = new Schema<IComment>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    comment_id: { type: String, required: true },
    version: {
      source: { type: String, enum: ["draft", "baseline"], required: true },
      baseline_id: { type: String, default: null },
      label: { type: String, required: true }
    },
    anchor: {
      section_id: { type: String, required: true },
      block_index: { type: Number, default: null },
      label: { type: String, required: true },
      excerpt: { type: String, default: null }
    },
    author_id: { type: Schema.Types.ObjectId, ref: "User", required: true },
    author_role: { type: String, enum: ORG_ROLES, required: true },
    text: { type: String, required: true, trim: true, maxlength: COMMENT_TEXT_MAX },
    status: { type: String, enum: COMMENT_STATUSES, default: "open" },
    cr_id: { type: String, default: null },
    handled_by: { type: Schema.Types.ObjectId, ref: "User", default: null },
    handled_at: { type: Date, default: null },
    resolution: {
      type: new Schema<CommentResolution>(
        { kind: { type: String, enum: COMMENT_RESOLUTIONS, required: true }, reason: { type: String, default: null } },
        { _id: false }
      ),
      default: null
    },
    replies: { type: [replySchema], default: [] }
  },
  { timestamps: true }
)

commentSchema.index({ projectId: 1, comment_id: 1 }, { unique: true })
commentSchema.index({ projectId: 1, status: 1, createdAt: 1 })

export const Comment = mongoose.model<IComment>("Comment", commentSchema)

/** Bộ đếm `CM-nnn` theo project — `$inc` nguyên tử nên hai comment cùng lúc không trùng mã. */
interface ICommentCounter extends Document {
  projectId: mongoose.Types.ObjectId
  seq: number
}

const commentCounterSchema = new Schema<ICommentCounter>({
  projectId: { type: Schema.Types.ObjectId, required: true, unique: true },
  seq: { type: Number, default: 0 }
})

export const CommentCounter = mongoose.model<ICommentCounter>("CommentCounter", commentCounterSchema)
