/**
 * FLF-278 trên FLF-335/336 — dữ liệu cấp tổ chức, dùng lại qua nhiều dự án theo mẫu khách:
 *  - `OrgTemplate`: file mẫu (bản sao trong kho file) + mapping heading BA đã xác nhận ở một dự án. Dự án sau chọn mẫu ⇒
 *    import từ chính file đó, mapping áp sẵn (bỏ bước 1.5 xác nhận).
 *  - `OrgContentEntry`: nội dung chuẩn của tổ chức theo tiêu đề mục (Document Conventions, References…). Chỉ là nguồn gợi ý —
 *    vào Spine qua bản xem trước / change request, không ghi thẳng.
 */
import mongoose, { Schema, type Document } from "mongoose"
import type { CustomBlock } from "../spine/spine.types.js"

const opts = { _id: false, strict: "throw" as const }

export interface OrgTemplateHeading {
  heading_text: string
  section_id: string
}

export interface IOrgTemplate extends Document {
  orgId: mongoose.Types.ObjectId
  name: string
  source_file: { name: string; size: number; sha256: string }
  /** File mẫu trong kho `docFileStore` (bản sao riêng — xoá dự án gốc không mất). */
  file_ref: string
  template_family: string | null
  /** Mapping heading theo đúng thứ tự heading của file (cùng sha256 ⇒ cùng thứ tự). */
  headings: OrgTemplateHeading[]
  created_by: mongoose.Types.ObjectId
  uses: number
  createdAt: Date
  updatedAt: Date
}

const orgTemplateSchema = new Schema<IOrgTemplate>(
  {
    orgId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    source_file: {
      type: new Schema({ name: { type: String, required: true }, size: { type: Number, required: true, min: 0 }, sha256: { type: String, required: true, match: /^[a-f0-9]{64}$/ } }, opts),
      required: true
    },
    file_ref: { type: String, required: true },
    template_family: { type: String, default: null },
    headings: {
      type: [new Schema({ heading_text: { type: String, required: true }, section_id: { type: String, required: true } }, opts)],
      required: true
    },
    created_by: { type: Schema.Types.ObjectId, ref: "User", required: true },
    uses: { type: Number, default: 0, min: 0 }
  },
  { timestamps: true, collection: "org_templates" }
)

export const OrgTemplate = mongoose.model<IOrgTemplate>("OrgTemplate", orgTemplateSchema)

export interface IOrgContentEntry extends Document {
  orgId: mongoose.Types.ObjectId
  title: string
  /** Tiêu đề đã chuẩn hoá (`normalizeTitle`) — unique theo org. */
  key: string
  blocks: CustomBlock[]
  updated_by: mongoose.Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const orgContentSchema = new Schema<IOrgContentEntry>(
  {
    orgId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    key: { type: String, required: true },
    blocks: {
      type: [
        new Schema(
          {
            kind: { type: String, enum: ["paragraph", "list_item"], required: true },
            text: { type: String, required: true, maxlength: 4000 },
            rows: { type: Schema.Types.Mixed, default: null },
            image_ref: { type: String, default: null }
          },
          opts
        )
      ],
      required: true
    },
    updated_by: { type: Schema.Types.ObjectId, ref: "User", required: true }
  },
  { timestamps: true, collection: "org_content_entries" }
)
orgContentSchema.index({ orgId: 1, key: 1 }, { unique: true })

export const OrgContentEntry = mongoose.model<IOrgContentEntry>("OrgContentEntry", orgContentSchema)
