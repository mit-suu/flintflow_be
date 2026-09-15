/**
 * Cache `RenderedDocument` (S-8.2) theo `spine_version` — collection `rendered_documents`.
 * KHÔNG phải Spine: ghi tự do ở đây không phạm điều cấm "ghi Spine ngoài op-engine"
 * (coding-rules §3.3) — đây là một document cache riêng, độc lập với collection `spines`.
 *
 * Chỉ cache bản `draft`; bản `baseline` luôn dựng lại từ `Baseline.snapshot` (rẻ, bất biến,
 * không cần cache — `assemble.service.ts`).
 */

import mongoose, { Schema } from "mongoose"

const renderedDocumentCacheSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    spine_version: { type: Number, required: true, min: 1 },
    assembled_at_version: { type: Number, required: true, min: 1 },
    generated_at: { type: Date, required: true },
    /** `RenderedDocument` (rendered-document.schema.ts) — ảnh PNG lưu dạng base64 (string), không Buffer. */
    doc: { type: Schema.Types.Mixed, required: true }
  },
  { timestamps: true, strict: true, minimize: false }
)

renderedDocumentCacheSchema.index({ projectId: 1, spine_version: 1 }, { unique: true })

export const RenderedDocumentCache = mongoose.model("RenderedDocumentCache", renderedDocumentCacheSchema)
