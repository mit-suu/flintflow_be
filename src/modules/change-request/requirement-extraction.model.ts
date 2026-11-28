/**
 * requirement-extraction.model.ts
 * ─────────────────────────────────────────────────────────────────
 * FLF-338 — business-flow §3.6.1 "Rút yêu cầu từ tài liệu thô": danh sách yêu cầu AI rút từ một tài liệu tham khảo
 * (`ProjectDocument`), mỗi mục trỏ về đoạn nguồn (`D1-P03` + trích dẫn) và mang một nhãn gợi ý. BA duyệt danh sách (tick /
 * bỏ + lý do / trả lời câu hỏi) ⇒ mỗi nhóm thành một change request (`cr_id`). Một tài liệu một bản rút đang mở; rút lại
 * thay bản chưa duyệt.
 *
 * FLF-449 (P6): nhãn `inferred` (Suy ra) kèm khối `inference` (triệu chứng + câu trích, gốc rễ, lý do, 2 phương án ưu / nhược /
 * rủi ro, khuyến nghị tuỳ chọn, mục tiêu phục vụ); người nói (`speaker`), các phía của mâu thuẫn (`sides`), đầu danh sách
 * hiện trạng / mong muốn (`situation`); chỗ Code đã tra trong SRS (`located_paths`, thành `seed.targets` của CR). Mọi trường
 * mới optional / có mặc định ⇒ bản rút cũ đọc được.
 */

import mongoose, { Schema } from "mongoose"

export const EXTRACTION_LABELS = ["new", "modification", "duplicate", "contradiction", "ambiguous", "inferred"] as const
export type ExtractionLabel = (typeof EXTRACTION_LABELS)[number]

export const EXTRACTION_STATUSES = ["extracted", "approved"] as const
export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number]

/**
 * Một phương án của mục Suy ra. Tương thích kiểu `OptionAnalysis` chung (FLF-449 N1: label, description?, pros, cons, risks)
 * đang làm ở nhánh khác — gộp sau thì thay bằng kiểu chung.
 */
export interface ExtractionOption {
  label: string
  description: string | null
  pros: string[]
  cons: string[]
  risks: string[]
}

/** Khối "Suy ra" (BF §3.6.1): triệu chứng có câu trích bắt buộc; khuyến nghị chỉ khi AI chắc chắn (03 Đã chốt #3). */
export interface ExtractionInference {
  symptom: string
  symptom_quote: string
  symptom_para_id: string | null
  root_cause: string
  rationale: string
  options: ExtractionOption[]
  /** Chỉ số phương án khuyến nghị (0-based); `null` = các phương án ngang nhau. */
  recommended: number | null
  recommendation_reason: string | null
  /** Mục tiêu của dự án mà nhu cầu phục vụ, chép nguyên văn; `null` khi dự án chưa có mục tiêu. */
  serves_goal: string | null
}

/** Một phía của mâu thuẫn: ai nói (khi tài liệu ghi rõ), đoạn nguồn, câu trích. */
export interface ExtractionSide {
  speaker: string | null
  para_id: string | null
  quote: string
}

/** Một ý hiện trạng / mong muốn ở đầu danh sách, kèm đoạn nguồn + câu trích. */
export interface SituationPoint {
  text: string
  para_id: string | null
  quote: string
}

export interface ExtractionSituation {
  current: SituationPoint[]
  desired: SituationPoint[]
}

export interface IExtractionItem {
  id: string
  text: string
  label: ExtractionLabel
  para_id: string | null
  quote: string
  group: string
  entity_paths: string[]
  /** Tên đọc được của từng phần tử trong `entity_paths` (cùng thứ tự; "" khi không có tên) — UI không in đường dẫn thô. */
  entity_names?: string[]
  /** Chỗ Code đã tra trong SRS cho yêu cầu này (nhắc tên / mã, gần nghĩa) — cùng `entity_paths` thành `seed.targets` của CR. */
  located_paths?: string[]
  /** Người nói, chỉ khi tài liệu ghi rõ (biên bản, transcript). */
  speaker?: string | null
  /** Mâu thuẫn: các phía, mỗi phía kèm người nói + câu trích. */
  sides?: ExtractionSide[]
  inference?: ExtractionInference | null
  question: string | null
  suggested_answers: string[]
  /** Quyết định của BA lúc duyệt. */
  include: boolean | null
  drop_reason: string | null
  answer: string | null
  /** Mục Suy ra: phương án BA chọn (chỉ số trong `inference.options`). */
  chosen_option?: number | null
  cr_id: string | null
}

export interface IRequirementExtraction {
  projectId: mongoose.Types.ObjectId
  documentId: mongoose.Types.ObjectId
  document_name: string
  doc_code: number
  status: ExtractionStatus
  /** Đầu danh sách: hiện trạng / mong muốn kèm câu trích (bản rút cũ: rỗng). */
  situation?: ExtractionSituation
  items: IExtractionItem[]
  /** Số lô tài liệu đã đọc (mỗi lô một lượt AI); bản rút cũ: 1. */
  batches?: number
  credits: number
  created_by: mongoose.Types.ObjectId
  approved_at: Date | null
  createdAt: Date
  updatedAt: Date
}

const optionSchema = new Schema<ExtractionOption>(
  {
    label: { type: String, required: true },
    description: { type: String, default: null },
    pros: { type: [String], default: [] },
    cons: { type: [String], default: [] },
    risks: { type: [String], default: [] }
  },
  { _id: false }
)

const inferenceSchema = new Schema<ExtractionInference>(
  {
    symptom: { type: String, required: true },
    symptom_quote: { type: String, required: true },
    symptom_para_id: { type: String, default: null },
    root_cause: { type: String, default: "" },
    rationale: { type: String, default: "" },
    options: { type: [optionSchema], default: [] },
    recommended: { type: Number, default: null },
    recommendation_reason: { type: String, default: null },
    serves_goal: { type: String, default: null }
  },
  { _id: false }
)

const sideSchema = new Schema<ExtractionSide>(
  { speaker: { type: String, default: null }, para_id: { type: String, default: null }, quote: { type: String, default: "" } },
  { _id: false }
)

const situationPointSchema = new Schema<SituationPoint>(
  { text: { type: String, required: true }, para_id: { type: String, default: null }, quote: { type: String, default: "" } },
  { _id: false }
)

const itemSchema = new Schema<IExtractionItem>(
  {
    id: { type: String, required: true },
    text: { type: String, required: true },
    label: { type: String, enum: EXTRACTION_LABELS, required: true },
    para_id: { type: String, default: null },
    quote: { type: String, default: "" },
    group: { type: String, required: true },
    entity_paths: { type: [String], default: [] },
    entity_names: { type: [String], default: [] },
    located_paths: { type: [String], default: [] },
    speaker: { type: String, default: null },
    sides: { type: [sideSchema], default: [] },
    inference: { type: inferenceSchema, default: null },
    question: { type: String, default: null },
    suggested_answers: { type: [String], default: [] },
    include: { type: Boolean, default: null },
    drop_reason: { type: String, default: null },
    answer: { type: String, default: null },
    chosen_option: { type: Number, default: null },
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
    situation: {
      type: new Schema<ExtractionSituation>(
        { current: { type: [situationPointSchema], default: [] }, desired: { type: [situationPointSchema], default: [] } },
        { _id: false }
      ),
      default: () => ({ current: [], desired: [] })
    },
    items: { type: [itemSchema], default: [] },
    batches: { type: Number, default: 1 },
    credits: { type: Number, default: 0 },
    created_by: { type: Schema.Types.ObjectId, ref: "User", required: true },
    approved_at: { type: Date, default: null }
  },
  { timestamps: true, strict: true, minimize: false }
)

extractionSchema.index({ projectId: 1, documentId: 1 }, { unique: true })

export const RequirementExtraction = mongoose.model<IRequirementExtraction>("RequirementExtraction", extractionSchema)
