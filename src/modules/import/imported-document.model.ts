/**
 * Một lần upload .docx cho project mode 1 (nút 1.1–1.3) và trạng thái import của nó. FLF-171, plan §5.2.
 * File gốc lưu GridFS (bucket `source-docs`, P2); `sha256` là của file **người dùng upload** — bản lưu
 * sau import có thêm stamp + bookmark ẩn `_ff_<blockId>` nên khác byte (G3).
 * Upload bị từ chối cũng giữ bản ghi (`preflight_rejected`) để hiện lỗi; upload lại = bản ghi mới.
 */

import mongoose, { Schema, Document } from "mongoose"
import { IMPORT_PAUSE_REASONS, IMPORT_STATUSES, type ImportPauseReason, type ImportStatus } from "./import.state.js"
import { PREFLIGHT_ISSUE_CODES, type PreflightIssueCode } from "./import.constants.js"
import type { FinalizeRequest } from "./import.dto.js"
import type { Spine } from "../spine/spine.types.js"

export interface PreflightIssue {
  code: PreflightIssueCode
  message: string
  /** Vị trí trong tài liệu nếu xác định được (đoạn thứ `block_ord`, trích text). */
  location?: { block_ord: number; text: string } | null
}

export interface DocStamp {
  project_id: string
  version: string | null
  source: string | null
}

export interface FinalizeCheckpoint {
  spine_version: number
  /** Nội dung Spine lúc ghi mốc (trước finalize — mode 1 chưa ghi gì nên rất nhỏ); lần chạy dở được đưa về đúng bản này. */
  spine: Spine
  next_seq: number
  headings: { block_id: string; section_id: string }[]
  /** Record of Changes người dùng gửi kèm finalize (FLF-252) — chạy lại (resume) dùng lại, không đọc lại từ file. */
  record_of_changes: FinalizeRequest["record_of_changes"] | null
}

export interface IImportedDocument extends Document {
  projectId: mongoose.Types.ObjectId
  file_ref: string | null
  sha256: string
  original_name: string
  size: number
  preflight: { status: "accepted" | "rejected"; issues: PreflightIssue[] }
  stamp: DocStamp | null
  confirmed_latest_at: Date | null
  status: ImportStatus
  paused: { reason: ImportPauseReason; at: Date } | null
  /** Section đang/sắp trích ở I-4; resume chạy tiếp từ đây, không trích lại section `done`. */
  extract_cursor: string | null
  /**
   * Mốc ngay trước lần finalize đang/đã chạy nền (`finalize-jobs.ts`): nội dung Spine, `seq` change kế tiếp và
   * section của từng heading (finalize đổi section tạm `feature:@B…` sang id thật). Lần chạy dở (lỗi / máy chủ khởi
   * động lại giữa `baselining`) được hoàn về mốc này trước khi chạy lại. `null` = chưa finalize lần nào.
   */
  finalize_checkpoint: FinalizeCheckpoint | null
  created_by: mongoose.Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const opts = { _id: false }

const preflightIssueSchema = new Schema(
  {
    code: { type: String, enum: PREFLIGHT_ISSUE_CODES, required: true },
    message: { type: String, required: true },
    location: { type: new Schema({ block_ord: Number, text: String }, opts), default: null }
  },
  opts
)

const importedDocumentSchema = new Schema<IImportedDocument>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    file_ref: { type: String, default: null },
    sha256: { type: String, required: true },
    original_name: { type: String, required: true },
    size: { type: Number, required: true, min: 0 },
    preflight: {
      type: new Schema(
        {
          status: { type: String, enum: ["accepted", "rejected"], required: true },
          issues: { type: [preflightIssueSchema], default: [] }
        },
        opts
      ),
      required: true
    },
    stamp: {
      type: new Schema({ project_id: { type: String, required: true }, version: String, source: String }, opts),
      default: null
    },
    confirmed_latest_at: { type: Date, default: null },
    status: { type: String, enum: IMPORT_STATUSES, default: "uploaded" },
    paused: {
      type: new Schema({ reason: { type: String, enum: IMPORT_PAUSE_REASONS, required: true }, at: { type: Date, required: true } }, opts),
      default: null
    },
    extract_cursor: { type: String, default: null },
    finalize_checkpoint: {
      type: new Schema(
        {
          spine_version: { type: Number, required: true },
          spine: { type: Schema.Types.Mixed, required: true },
          next_seq: { type: Number, required: true },
          headings: { type: [new Schema({ block_id: { type: String, required: true }, section_id: { type: String, required: true } }, opts)], default: [] },
          record_of_changes: { type: Schema.Types.Mixed, default: null }
        },
        opts
      ),
      default: null
    },
    created_by: { type: Schema.Types.ObjectId, ref: "User", required: true }
  },
  { timestamps: true }
)

// Bản ghi mới nhất của project = import đang hiệu lực
importedDocumentSchema.index({ projectId: 1, createdAt: -1 })

export const ImportedDocument = mongoose.model<IImportedDocument>("ImportedDocument", importedDocumentSchema)
