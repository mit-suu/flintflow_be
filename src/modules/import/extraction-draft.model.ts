/**
 * Kết quả trích field Spine của một section (I-4, nút 1.8–1.9). Chưa ghi vào Spine: finalize áp mọi field
 * đã xác nhận trong một transaction `by: "import"`. FLF-171, plan §5.2.
 * `fields[]` là dạng phẳng cho màn xác nhận (UC-22); AI trả theo thực thể (response-parser `importExtract`)
 * rồi code làm phẳng. `ops[]` là op dựng sẵn (định dạng `op.types.ts`), đã chạy khô qua `planTransaction`.
 */

import mongoose, { Schema, Document } from "mongoose"
import type { DiagramImageKind, ImportExtractDiagramOutput, ImportExtractOutput } from "../../shared/ai/response-parser.js"
import type { EntityItem } from "./extracted-entities.js"
import { EXTRACTION_STATUSES, FIELD_ORIGINS, type ExtractionStatus, type FieldOrigin } from "./import.constants.js"

export interface ExtractedField {
  /** Path Spine phân giải qua khoá, vd `use_cases[id=UC-01].name`. */
  path: string
  value: unknown
  confidence: number
  source_block_ids: string[]
  /** `deterministic` = trích từ bảng khớp đủ cột (G7), không tốn credit; `vision` = đọc từ ảnh (phase 5). */
  origin: FieldOrigin
  confirmed: boolean
  edited_value?: unknown
}

/**
 * Output một lượt AI của I-4 (FLF-392) — `data` là output đã qua parse schema (không phải text thô của provider). Cấp mã /
 * ghép tên / lọc chạy lúc ghép section (replay theo thứ tự tài liệu), không chạy lúc đọc.
 * Ảnh: `read` (có `data`, `usage_id`), `unsupported` / `unavailable` / `failed` (không có dữ liệu).
 */
export type RawAiStep =
  | { kind: "image"; block_id: string; status: "read" | "unsupported" | "unavailable" | "failed"; data?: ImportExtractDiagramOutput; usage_id?: string }
  | { kind: "text"; data: ImportExtractOutput; usage_id: string }

/**
 * Tiến độ AI của section đang dở (lượt = một ảnh diagram hoặc một lô chữ, theo `sectionAiSteps`). Lưu sau mỗi lượt đã trừ
 * credit (kể cả lượt cuối: đọc xong mà chưa ghép); section ghép xong ⇒ `null`. Chạy tiếp chỉ dùng lại khi `plan_hash` khớp.
 * FLF-392: `raw_steps` = output của các lượt cuối, `steps_done - raw_steps.length` lượt đầu (bản ghi trước FLF-392) đã xử
 * lý sẵn vào `items` / `unmapped_block_ids` / `diagram_images` / `usage_id` (đã cấp id).
 */
export interface ExtractionProgress {
  plan_hash: string
  /** Số lượt đầu đã xong — chạy tiếp bắt đầu ở lượt thứ `steps_done` (đếm từ 0). */
  steps_done: number
  raw_steps?: RawAiStep[]
  /** Phần tử của các lượt đã xử lý sẵn (bản ghi trước FLF-392) — chưa gộp, chưa làm phẳng. */
  items?: EntityItem[]
  unmapped_block_ids?: string[]
  diagram_images?: IExtractionDraft["diagram_images"]
  usage_id?: string | null
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
  /**
   * Ảnh diagram của section đã qua I-4 phần ảnh (mode 1 v3 phase 5): `kind` = loại model đọc được, `unsupported` =
   * không gửi được (EMF/WMF, file gốc không còn), `other` = không phải diagram đọc được, `unavailable` = AI đọc ảnh lỗi
   * sau mọi lượt thử (Gemini quá tải cả model dự phòng — FLF-360: lỗi tạm thời, được đọc lại), `failed` = AI lỗi không tự
   * khỏi (không đọc lại). Finalize: mọi ảnh giữ nguyên (§4.13); 4 loại diagram đọc được ⇒ đánh dấu sơ đồ gốc, còn lại ⇒
   * cờ vàng `import_image_unread`.
   */
  /** FLF-390: `owner_id` = function chủ của ảnh sequence / activity. */
  diagram_images: { block_id: string; kind: DiagramImageKind | "unsupported" | "unavailable" | "failed"; owner_id?: string | null }[]
  /** Usage của lượt gọi AI (null nếu section chỉ trích deterministic). */
  usage_id: string | null
  partial: ExtractionProgress | null
  /**
   * FLF-444: tên mục và nội dung khác nhau (mục "Use Case" chứa test case; mọi phần tử AI đọc ra thuộc loại khác mục) -
   * I-4 tin nội dung, phần tử AI của mục bị hạ độ tin để người xác nhận ở bước 1.6. `null` = khớp.
   * FLF-462: `confirmed` = người dùng đã xem ở bước 1.6 (không đổi phân loại, chỉ bỏ cờ chờ xác nhận).
   */
  content_mismatch: { by_heading: string[]; by_content: string[]; note: string | null; confirmed: boolean } | null
  /**
   * FLF-444: kết quả lớp 4 chữ hướng dẫn của AI theo block (chỗ cho bước 1.6).
   * FLF-462: `confirmed` = người dùng đã xác nhận `is_guidance` ở bước 1.6 (có thể sửa lại giá trị AI chấm).
   */
  guidance_blocks: { block_id: string; is_guidance: boolean; confidence: number; confirmed: boolean }[]
  /** FLF-444: loại nội dung 29148 theo block (chỗ cho phân loại Ngoài phạm vi). */
  content_types: { block_id: string; iso29148: string; in_scope: boolean; confidence: number }[]
  error: string | null
  /** Lúc section bắt đầu gọi AI; `null` khi không đang đọc (ghi bằng `$set` riêng, không qua `save()` của draft). */
  reading_since: Date | null
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
            origin: { type: String, enum: FIELD_ORIGINS, required: true },
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
    diagram_images: { type: [new Schema({ block_id: { type: String, required: true }, kind: { type: String, required: true }, owner_id: { type: String, default: undefined } }, opts)], default: [] },
    usage_id: { type: String, default: null },
    partial: { type: Schema.Types.Mixed, default: null },
    content_mismatch: { type: Schema.Types.Mixed, default: null },
    guidance_blocks: {
      type: [
        new Schema(
          { block_id: { type: String, required: true }, is_guidance: { type: Boolean, required: true }, confidence: { type: Number, required: true }, confirmed: { type: Boolean, default: false } },
          opts
        )
      ],
      default: []
    },
    content_types: {
      type: [new Schema({ block_id: { type: String, required: true }, iso29148: { type: String, required: true }, in_scope: { type: Boolean, required: true }, confidence: { type: Number, required: true } }, opts)],
      default: []
    },
    error: { type: String, default: null },
    reading_since: { type: Date, default: null }
  },
  { timestamps: true, minimize: false }
)

extractionDraftSchema.index({ import_id: 1, section_id: 1 }, { unique: true })

export const ExtractionDraft = mongoose.model<IExtractionDraft>("ExtractionDraft", extractionDraftSchema)
