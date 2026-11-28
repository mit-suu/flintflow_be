import mongoose, { Schema, type Document } from "mongoose"

/**
 * UC-85 / UC-88 - đề xuất lưu cấu trúc dự án thành mẫu tổ chức.
 *
 * - `proposed`: vừa dựng sau baseline, chờ tác giả baseline chọn (Analyst: Send to Lead; Lead: Save to library; Don't save).
 * - `sent`: Analyst đã gửi, chờ Lead duyệt (UC-88).
 * - `approved`: đã đăng vào thư viện (`template_id` / `version`), dự án nguồn theo bản đó.
 * - `rejected` / `declined`: Lead từ chối / tác giả bỏ ⇒ cùng cấu trúc (`structure_hash`) không đề xuất lại.
 * - `superseded`: baseline sau có cấu trúc khác thay đề xuất còn mở.
 */
export const TEMPLATE_PROPOSAL_STATUSES = ["proposed", "sent", "approved", "rejected", "declined", "superseded"] as const
export type TemplateProposalStatus = (typeof TEMPLATE_PROPOSAL_STATUSES)[number]

/** Cấu trúc này không bao giờ được đề xuất lại (AUC UC-85: "the same structure was declined or rejected before → no card"). */
export const CLOSED_FOR_GOOD: readonly TemplateProposalStatus[] = ["rejected", "declined"]
/** Đề xuất còn chờ người quyết định. */
export const OPEN_STATUSES: readonly TemplateProposalStatus[] = ["proposed", "sent"]

/** Một heading AI đổi tên riêng thành chỗ trống (`generic`), hoặc bỏ vì chỉ dùng được cho dự án này (`generic: null`). */
export interface ProposalReplacedName {
  key: string
  original: string
  generic: string | null
  reason: string | null
  /** Chỗ đổi: heading, chữ hướng dẫn hay tiêu đề cột (bản ghi cũ không có = heading). */
  kind?: "heading" | "guidance" | "column"
}

/** Chữ hướng dẫn / tiêu đề cột đã đổi tên riêng (khoá theo chữ gốc đã cắt khoảng trắng). */
export interface ProposalTextReplacement {
  key: string
  original: string
  generic: string
}

/** Quyết định áp khi dựng lại file khung (cùng kiểu `PendingDecision` của `template-skeleton.ts`). */
export interface ProposalDecision {
  key: string
  decision: "keep" | "generic" | "drop"
  generic_text: string | null
}

export interface ITemplateProposal extends Document {
  orgId: mongoose.Types.ObjectId
  project_id: mongoose.Types.ObjectId
  /** File của baseline / bản phát hành dựng ra khung (dựng lại khi đăng). */
  source_ref: string
  structure_hash: string
  decisions: ProposalDecision[]
  replaced_names: ProposalReplacedName[]
  text_replacements: ProposalTextReplacement[]
  /** Heading của khung sau khi đổi tên - để người quyết định xem cấu trúc mà không cần mở file. */
  headings: { heading_text: string }[]
  status: TemplateProposalStatus
  /** Tác giả baseline - người duy nhất thấy thẻ đề xuất. */
  created_by: mongoose.Types.ObjectId
  sent_by: mongoose.Types.ObjectId | null
  decided_by: mongoose.Types.ObjectId | null
  decided_at: Date | null
  template_id: mongoose.Types.ObjectId | null
  version: number | null
  createdAt: Date
  updatedAt: Date
}

const templateProposalSchema = new Schema<ITemplateProposal>(
  {
    orgId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    project_id: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    source_ref: { type: String, required: true },
    structure_hash: { type: String, required: true },
    decisions: {
      type: [new Schema({ key: String, decision: { type: String, enum: ["keep", "generic", "drop"] }, generic_text: { type: String, default: null } }, { _id: false })],
      default: []
    },
    replaced_names: {
      type: [new Schema({ key: String, original: String, generic: { type: String, default: null }, reason: { type: String, default: null }, kind: { type: String, enum: ["heading", "guidance", "column"], default: "heading" } }, { _id: false })],
      default: []
    },
    text_replacements: { type: [new Schema({ key: String, original: String, generic: String }, { _id: false })], default: [] },
    headings: { type: [new Schema({ heading_text: String }, { _id: false })], default: [] },
    status: { type: String, enum: TEMPLATE_PROPOSAL_STATUSES, required: true },
    created_by: { type: Schema.Types.ObjectId, ref: "User", required: true },
    sent_by: { type: Schema.Types.ObjectId, ref: "User", default: null },
    decided_by: { type: Schema.Types.ObjectId, ref: "User", default: null },
    decided_at: { type: Date, default: null },
    template_id: { type: Schema.Types.ObjectId, ref: "OrgTemplate", default: null },
    version: { type: Number, default: null }
  },
  { timestamps: true, collection: "template_proposals" }
)

templateProposalSchema.index({ project_id: 1, structure_hash: 1 })
templateProposalSchema.index({ orgId: 1, status: 1, createdAt: -1 })

export const TemplateProposal = mongoose.model<ITemplateProposal>("TemplateProposal", templateProposalSchema)
