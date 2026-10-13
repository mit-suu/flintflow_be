import mongoose, { Schema, Document } from "mongoose"
import { ORG_ROLES, type OrgRole } from "../organization/membership.model.js"

/**
 * Comment ghim vào nội dung SRS (UC-49, SRS v6 §3.9.3). Comment KHÔNG đổi nội dung (BR-05): sau baseline, Analyst
 * hoặc Lead chuyển nó thành change request nguồn "Viewer comment" (UC-41) — lúc đó status thành `converted`.
 */
export const COMMENT_STATUSES = ["open", "resolved", "converted"] as const
export type CommentStatus = (typeof COMMENT_STATUSES)[number]

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
