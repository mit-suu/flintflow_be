/**
 * requirement-extraction.model.ts
 * ─────────────────────────────────────────────────────────────────
 * FLF-338 — business-flow §3.6.1 "Rút yêu cầu từ tài liệu thô": danh sách yêu cầu AI rút từ một tài liệu tham khảo
 * (`ProjectDocument`), mỗi mục trỏ về đoạn nguồn (`D1-P03` + trích dẫn) và mang một nhãn gợi ý. BA duyệt danh sách (tick /
 * bỏ + lý do / trả lời câu hỏi) ⇒ mỗi nhóm thành một change request (`cr_id`). Một tài liệu một bản rút đang mở; rút lại
 * thay bản chưa duyệt.
 */

import mongoose, { Schema } from "mongoose"

export const EXTRACTION_LABELS = ["new", "modification", "duplicate", "contradiction", "ambiguous"] as const
export type ExtractionLabel = (typeof EXTRACTION_LABELS)[number]

export const EXTRACTION_STATUSES = ["extracted", "approved"] as const
export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number]

export interface IExtractionItem {
  id: string
  text: string
  label: ExtractionLabel
  para_id: string | null
  quote: string
  group: string
  entity_paths: string[]
  question: string | null
  suggested_answers: string[]
  /** Quyết định của BA lúc duyệt. */
  include: boolean | null
  drop_reason: string | null
  answer: string | null
  cr_id: string | null
}

export interface IRequirementExtraction {
  projectId: mongoose.Types.ObjectId
  documentId: mongoose.Types.ObjectId
  document_name: string
  doc_code: number
  status: ExtractionStatus
  items: IExtractionItem[]
  credits: number
  created_by: mongoose.Types.ObjectId
  approved_at: Date | null
  createdAt: Date
  updatedAt: Date
}

const itemSchema = new Schema<IExtractionItem>(
  {
    id: { type: String, required: true },
    text: { type: String, required: true },
    label: { type: String, enum: EXTRACTION_LABELS, required: true },
    para_id: { type: String, default: null },
    quote: { type: String, default: "" },
    group: { type: String, required: true },
    entity_paths: { type: [String], default: [] },
    question: { type: String, default: null },
    suggested_answers: { type: [String], default: [] },
    include: { type: Boolean, default: null },
    drop_reason: { type: String, default: null },
    answer: { type: String, default: null },
    cr_id: { type: String, default: null }
  },
  { _id: false }
)

const extractionSchema = new Schema<IRequirementExtraction>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    documentId: { type: Schema.Types.ObjectId, ref: "ProjectDocument", required: true },
    document_name: { type: String, required: true },
    doc_code: { type: Number, required: true },
    status: { type: String, enum: EXTRACTION_STATUSES, default: "extracted" },
    items: { type: [itemSchema], default: [] },
    credits: { type: Number, default: 0 },
    created_by: { type: Schema.Types.ObjectId, ref: "User", required: true },
    approved_at: { type: Date, default: null }
  },
  { timestamps: true, strict: true, minimize: false }
)

extractionSchema.index({ projectId: 1, documentId: 1 }, { unique: true })

export const RequirementExtraction = mongoose.model<IRequirementExtraction>("RequirementExtraction", extractionSchema)
