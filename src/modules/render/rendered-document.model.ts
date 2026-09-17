/**
 * Cache `RenderedDocument` (S-8.2) theo `spine_version` — collection `rendered_documents`.
 * KHÔNG phải Spine: ghi tự do ở đây không phạm điều cấm "ghi Spine ngoài op-engine"
 * (coding-rules §3.3) — đây là một document cache riêng, độc lập với collection `spines`.
 *
 * Một document trong collection này là MỘT trong hai dạng, phân biệt bởi field nào có mặt:
 * - draft    : `spine_version` + `assembled_at_version` có mặt, `baseline_id` vắng mặt.
 * - baseline : `baseline_id` có mặt (T15 review T5 — trước đây bản baseline không cache, dựng lại
 *   mỗi lần xem dù snapshot bất biến), `spine_version`/`assembled_at_version` vắng mặt.
 *
 * `doc.sections[].blocks[].png` (khi là ảnh) không lưu base64 thật — section sinh sẵn tham chiếu
 * `diagram-ref:<diagramId>`, PNG tải lại lúc đọc (T15 review T6, xem `assemble.service.ts`
 * `rehydrateImages`/`materializeImages`) để tránh phình document tới trần 16MB của Mongo. Ảnh chưa
 * tải được lúc assemble ghi ở `missing_diagram_ids`; lúc đọc ảnh đó là placeholder cho tới khi PNG có.
 */

import mongoose, { Schema } from "mongoose"

const renderedDocumentCacheSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    /** Chỉ có ở bản draft — khoá cùng `assembled_at_version`. */
    spine_version: { type: Number, min: 1 },
    /** Chỉ có ở bản baseline (T15 review T5) — trỏ `Baseline._id`, bất biến nên không cần versioning. */
    baseline_id: { type: Schema.Types.ObjectId, ref: "Baseline" },
    /** Chỉ có ở bản draft. */
    assembled_at_version: { type: Number, min: 1 },
    generated_at: { type: Date, required: true },
    /** `RenderedDocument` (rendered-document.schema.ts) — ảnh là tham chiếu `diagram-ref:<id>`, không phải base64 thật. */
    doc: { type: Schema.Types.Mixed, required: true },
    /**
     * Id sơ đồ `render_status = "ok"` mà PNG không tải được lúc assemble — để lần `POST /assemble` trúng cache
     * vẫn trả lại finding `diagram_png_missing`. Lúc đọc, tham chiếu vẫn được thử tải lại: PNG có sau ⇒ ảnh thật.
     */
    missing_diagram_ids: { type: [String], default: [] }
  },
  { timestamps: true, strict: true, minimize: false }
)

renderedDocumentCacheSchema.index(
  { projectId: 1, spine_version: 1 },
  { unique: true, partialFilterExpression: { spine_version: { $exists: true } } }
)
renderedDocumentCacheSchema.index(
  { projectId: 1, baseline_id: 1 },
  { unique: true, partialFilterExpression: { baseline_id: { $exists: true } } }
)

export const RenderedDocumentCache = mongoose.model("RenderedDocumentCache", renderedDocumentCacheSchema)
