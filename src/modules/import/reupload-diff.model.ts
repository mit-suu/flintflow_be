/**
 * Kết quả so bản upload lại (stamp đúng project) với version tài liệu mới nhất — nút 1.4, UC-24.
 * **Không** tạo version: user xem diff rồi (tuỳ) tạo CR nguồn `reupload`. FLF-171, plan §5.2.
 * Khớp block theo bookmark `_ff_` → `para_id` → LCS trên `text_hash` (engine dùng chung với `versions/compare`).
 */

import mongoose, { Schema, Document } from "mongoose"
import { REUPLOAD_CHANGES, type ReuploadChange } from "./import.constants.js"
import type { TableDiff } from "../doc-version/table-row-diff.js"
import type { ForeignMarkup } from "./preflight.service.js"

/** Loại block trong báo cáo khác biệt (FLF-447). */
export type DiffBlockKind = "paragraph" | "table" | "image" | "heading"

export interface BlockDiffEntry {
  /** `null` với block mới (`added`) chưa có id. */
  block_id: string | null
  change: ReuploadChange
  before?: string
  after?: string
  /** FLF-447: tiêu đề mục chứa block ("" = trước heading đầu). Bản ghi cũ không có ⇒ FE gom vào nhóm "Khác". */
  section?: string
  /** FLF-447: khoá mục = đường heading (mục trùng tên không bị gộp). */
  section_key?: string
  kind?: DiffBlockKind
  /** FLF-447: bảng khớp mà khác chữ ⇒ diff theo hàng. */
  table?: TableDiff
}

export interface IReuploadDiff extends Document {
  projectId: mongoose.Types.ObjectId
  file_ref: string | null
  sha256: string
  original_name: string
  against_version: string
  blocks: BlockDiffEntry[]
  /** FLF-447: số block không đổi theo mục; bản ghi cũ ⇒ []. */
  sections: { title: string; key?: string; unchanged: number }[]
  /** FLF-457: chưa có baseline ⇒ so với nội dung đang soạn (`against_version = "DRAFT"`); chỗ nhận thành bản sửa qua chat. */
  before_baseline: boolean
  /** FLF-457: file không có dấu version ⇒ so theo nội dung với bản nháp hiện tại. */
  no_stamp: boolean
  /** FLF-457: tỉ lệ heading của bản đang so tìm thấy trong file (0…1). */
  heading_match: number
  /** FLF-457: heading khớp dưới ngưỡng ⇒ gợi ý dùng làm tham khảo. */
  suggest_reference: boolean
  /** FLF-457: dấu version của file cũ hơn bản hiện tại. */
  stale: { file_version: string; current_version: string } | null
  /** FLF-457: Track Changes / comment của người ngoài trong file, mỗi chỗ một dòng. */
  markup: ForeignMarkup[]
  created_by: mongoose.Types.ObjectId
  createdAt: Date
}

const reuploadDiffSchema = new Schema<IReuploadDiff>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    file_ref: { type: String, default: null },
    sha256: { type: String, required: true },
    original_name: { type: String, required: true },
    against_version: { type: String, required: true },
    blocks: {
      type: [
        new Schema(
          {
            block_id: { type: String, default: null },
            change: { type: String, enum: REUPLOAD_CHANGES, required: true },
            before: String,
            after: String,
            section: { type: String, default: undefined },
            section_key: { type: String, default: undefined },
            kind: { type: String, default: undefined },
            table: { type: Schema.Types.Mixed, default: undefined }
          },
          { _id: false }
        )
      ],
      default: []
    },
    sections: { type: [new Schema({ title: { type: String, default: "" }, key: { type: String, default: undefined }, unchanged: { type: Number, required: true } }, { _id: false })], default: [] },
    before_baseline: { type: Boolean, default: false },
    no_stamp: { type: Boolean, default: false },
    heading_match: { type: Number, default: 1 },
    suggest_reference: { type: Boolean, default: false },
    stale: { type: new Schema({ file_version: { type: String, required: true }, current_version: { type: String, required: true } }, { _id: false }), default: null },
    markup: {
      type: [
        new Schema(
          {
            kind: { type: String, enum: ["track_change", "comment"], required: true },
            author: { type: String, default: "" },
            change: { type: String, enum: ["text", "format"], default: undefined },
            text: { type: String, default: "" },
            section: { type: String, default: "" },
            location: { type: new Schema({ block_ord: Number, text: String }, { _id: false }), default: null }
          },
          { _id: false }
        )
      ],
      default: []
    },
    created_by: { type: Schema.Types.ObjectId, ref: "User", required: true }
  },
  { timestamps: { createdAt: true, updatedAt: false } }
)

reuploadDiffSchema.index({ projectId: 1, createdAt: -1 })

export const ReuploadDiff = mongoose.model<IReuploadDiff>("ReuploadDiff", reuploadDiffSchema)
