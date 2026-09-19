/**
 * Template profile của tài liệu import: heading → section registry, cột bảng → field Spine (I-3, nút 1.6–1.7).
 * Một profile mỗi project. FLF-171, plan §5.2.
 * Heading nhận qua tên style/`outlineLvl` trong `styles.xml` (styleId bị Word bản địa hoá, vd `u1`) hoặc
 * theo mẫu số mục khi file không dùng style heading (spike P0 §4.2) — cách nhận ghi ở `detected_by`.
 */

import mongoose, { Schema, Document } from "mongoose"
import { HEADING_DETECTORS, type HeadingDetector } from "./import.constants.js"

export interface HeadingMapEntry {
  block_id: string
  heading_text: string
  /** Id section registry hoặc `"unmapped"`. */
  section_id: string
  confidence: number
  detected_by: HeadingDetector
  confirmed: boolean
}

export interface TableMapEntry {
  block_id: string
  column_index: number
  header: string
  /** Vd `use_cases[].id`; `null` = cột không ánh xạ. */
  field_path: string | null
  confidence: number
  confirmed: boolean
}

export interface ITemplateProfile extends Document {
  projectId: mongoose.Types.ObjectId
  source: "imported"
  doc_version: string
  heading_map: HeadingMapEntry[]
  table_map: TableMapEntry[]
  /** Section bắt buộc (registry `required`) không tìm thấy heading — đưa vào gap report. */
  required_sections: string[]
  /** Ngôn ngữ chính của tài liệu (`en`, `vi`…). */
  language: string
  createdAt: Date
  updatedAt: Date
}

const opts = { _id: false }
const confidence = { type: Number, required: true, min: 0, max: 1 }

const templateProfileSchema = new Schema<ITemplateProfile>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    source: { type: String, enum: ["imported"], default: "imported" },
    doc_version: { type: String, required: true },
    heading_map: {
      type: [
        new Schema(
          {
            block_id: { type: String, required: true },
            heading_text: { type: String, required: true },
            section_id: { type: String, required: true },
            confidence,
            detected_by: { type: String, enum: HEADING_DETECTORS, required: true },
            confirmed: { type: Boolean, default: false }
          },
          opts
        )
      ],
      default: []
    },
    table_map: {
      type: [
        new Schema(
          {
            block_id: { type: String, required: true },
            column_index: { type: Number, required: true, min: 0 },
            // Ô tiêu đề cột có thể trống trong SRS thật ⇒ không `required` (Mongoose coi "" là thiếu) — FLF-179
            header: { type: String, default: "" },
            field_path: { type: String, default: null },
            confidence,
            confirmed: { type: Boolean, default: false }
          },
          opts
        )
      ],
      default: []
    },
    required_sections: { type: [String], default: [] },
    language: { type: String, default: "en" }
  },
  { timestamps: true }
)

templateProfileSchema.index({ projectId: 1 }, { unique: true })

export const TemplateProfile = mongoose.model<ITemplateProfile>("TemplateProfile", templateProfileSchema)
