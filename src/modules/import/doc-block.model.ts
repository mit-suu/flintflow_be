/**
 * Block của tài liệu mode 1 theo từng version (I-2, nút 1.5). FLF-171, plan §5.2.
 * `block_id` (`B0001`…) ổn định qua các version: parse version mới giữ `block_id` theo neo.
 *
 * Neo (G3, chốt sau spike P0):
 * - `bookmark` — neo chính: bookmark ẩn `_ff_<block_id>` FlintFlow ghi vào bản lưu; Word giữ 100% với mọi nguồn file.
 * - `para_id` — neo phụ: `w14:paraId` nếu file có (chỉ file do Word lưu); Word sinh lại cho file do thư viện khác tạo.
 * - `text_hash` + `heading_path` + `ordinal` — dự phòng khi hai neo trên mất.
 */

import mongoose, { Schema, Document } from "mongoose"
import { DOC_BLOCK_KINDS, MENTION_ENTITIES, type DocBlockKind, type MentionEntity } from "./import.constants.js"

export interface BlockAnchor {
  bookmark: string | null
  para_id: string | null
  /** Đường dẫn trong `word/document.xml`, vd `body/tbl[2]/tr[1]/tc[0]/p[0]`. */
  xml_path: string
  /** Thứ tự block trong tài liệu (0-based). */
  ordinal: number
}

export interface IDocBlock extends Document {
  projectId: mongoose.Types.ObjectId
  doc_version: string
  block_id: string
  kind: DocBlockKind
  /** Cấp heading (1…9), `null` với block không phải heading. */
  level: number | null
  heading_path: string[]
  anchor: BlockAnchor
  text: string
  text_hash: string
  /** Section registry (`fixed:3.1.2`, `feature:<id>`…) theo template profile; `null` = chưa map / unmapped. */
  section_id: string | null
  mentions: { entity: MentionEntity; id: string }[]
  /** `false` với `unsupported`: giữ nguyên, CR không được sửa. */
  editable: boolean
  /** CR đang giữ khoá (nút 3.5); mở khi CR ghi xong / bị từ chối / huỷ / đóng. */
  locked_by_cr: string | null
  /** Mode 1 v3 phase 5 (T3): part ảnh trong file gốc (`word/media/…`) của block ảnh — render nhúng lại ảnh gốc. */
  image_ref?: string | null
}

const opts = { _id: false }

const docBlockSchema = new Schema<IDocBlock>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    doc_version: { type: String, required: true },
    block_id: { type: String, required: true },
    kind: { type: String, enum: DOC_BLOCK_KINDS, required: true },
    level: { type: Number, default: null, min: 0, max: 9 },
    heading_path: { type: [String], default: [] },
    anchor: {
      type: new Schema(
        {
          bookmark: { type: String, default: null },
          para_id: { type: String, default: null },
          xml_path: { type: String, required: true },
          ordinal: { type: Number, required: true, min: 0 }
        },
        opts
      ),
      required: true
    },
    text: { type: String, default: "" },
    image_ref: { type: String, default: null },
    text_hash: { type: String, required: true },
    section_id: { type: String, default: null },
    mentions: {
      type: [new Schema({ entity: { type: String, enum: MENTION_ENTITIES, required: true }, id: { type: String, required: true } }, opts)],
      default: []
    },
    editable: { type: Boolean, default: true },
    locked_by_cr: { type: String, default: null }
  },
  { timestamps: false }
)

docBlockSchema.index({ projectId: 1, doc_version: 1, block_id: 1 }, { unique: true })
docBlockSchema.index({ projectId: 1, locked_by_cr: 1 })
// Duyệt block theo thứ tự tài liệu
docBlockSchema.index({ projectId: 1, doc_version: 1, "anchor.ordinal": 1 })

export const DocBlock = mongoose.model<IDocBlock>("DocBlock", docBlockSchema)
