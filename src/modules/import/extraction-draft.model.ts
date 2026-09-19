/**
 * Kết quả trích field Spine của một section (I-4, nút 1.8–1.9). Chưa ghi vào Spine: finalize áp mọi field
 * đã xác nhận trong một transaction `by: "import"`. FLF-171, plan §5.2.
 * `fields[]` là dạng phẳng cho màn xác nhận (UC-22); AI trả theo thực thể (response-parser `importExtract`)
 * rồi code làm phẳng. `ops[]` là op dựng sẵn (định dạng `op.types.ts`), đã chạy khô qua `planTransaction`.
 */

import mongoose, { Schema, Document } from "mongoose"
import { EXTRACTION_STATUSES, type ExtractionStatus } from "./import.constants.js"

export interface ExtractedField {
  /** Path Spine phân giải qua khoá, vd `use_cases[id=UC-01].name`. */
  path: string
  value: unknown
  confidence: number
  source_block_ids: string[]
  /** `deterministic` = trích từ bảng khớp đủ cột (G7), không tốn credit. */
  origin: "deterministic" | "ai"
  confirmed: boolean
  edited_value?: unknown
}

export interface IExtractionDraft extends Document {
  projectId: mongoose.Types.ObjectId
  import_id: mongoose.Types.ObjectId
  section_id: string
  status: ExtractionStatus
  fields: ExtractedField[]
  ops: unknown[]
  /** Block AI báo không trích được (văn xuôi giới thiệu, ghi chú) — finalize giữ nguyên văn trong `custom_sections` (FLF-184). */
  unmapped_block_ids: string[]
  /** Usage của lượt gọi AI (null nếu section chỉ trích deterministic). */
  usage_id: string | null
  error: string | null
  createdAt: Date
  updatedAt: Date
}

const opts = { _id: false }

const extractionDraftSchema = new Schema<IExtractionDraft>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    import_id: { type: Schema.Types.ObjectId, ref: "ImportedDocument", required: true },
    section_id: { type: String, required: true },
    status: { type: String, enum: EXTRACTION_STATUSES, default: "pending" },
    fields: {
      type: [
        new Schema(
          {
            path: { type: String, required: true },
            value: { type: Schema.Types.Mixed },
            confidence: { type: Number, required: true, min: 0, max: 1 },
            source_block_ids: { type: [String], default: [] },
            origin: { type: String, enum: ["deterministic", "ai"], required: true },
            confirmed: { type: Boolean, default: false },
            edited_value: { type: Schema.Types.Mixed }
          },
          { ...opts, minimize: false }
        )
      ],
      default: []
    },
    ops: { type: [Schema.Types.Mixed], default: [] },
    unmapped_block_ids: { type: [String], default: [] },
    usage_id: { type: String, default: null },
    error: { type: String, default: null }
  },
  { timestamps: true, minimize: false }
)

extractionDraftSchema.index({ import_id: 1, section_id: 1 }, { unique: true })

export const ExtractionDraft = mongoose.model<IExtractionDraft>("ExtractionDraft", extractionDraftSchema)
