/**
 * Change request mode 1 (C-1, nút 3.1, UC-48). FLF-171, plan §5.4.
 * BR-03: đã có baseline thì mọi sửa phải qua CR. G1: chưa có role ⇒ người tạo tự duyệt, nhưng vẫn ghi
 * `submitted_at`, `decided_by` để khi có E5 chỉ thêm nhánh Analyst → Lead.
 */

import mongoose, { Schema, Document } from "mongoose"
import { CR_PAUSE_REASONS, CR_STATUSES, type CrPauseReason, type CrStatus } from "./change-request.state.js"
import { CR_ID_PATTERN, CR_SOURCE_KINDS, type CrSourceKind } from "./change-request.constants.js"

export interface CrSource {
  kind: CrSourceKind
  /** Tham chiếu: tiêu đề email, số biên bản, id ReuploadDiff, id comment… */
  ref: string | null
  note: string | null
}

export interface CrClarification {
  round: number
  questions: string[]
  answers: string[]
}

export interface IChangeRequest extends Document {
  projectId: mongoose.Types.ObjectId
  cr_id: string
  title: string
  description: string
  source: CrSource
  requester: string
  status: CrStatus
  paused: { reason: CrPauseReason; at: Date } | null
  clarifications: CrClarification[]
  /** Đích C-2 trả về khi CR đã rõ — C-3 tìm vị trí theo đó. Nội bộ, không có trong DTO. */
  targets: { entity_paths: string[]; keywords: string[] }
  /**
   * Mode 1 v3 (BPMN 3.1): bản xem trước người yêu cầu đính kèm khi tạo CR từ panel "Sửa tài liệu có xem trước".
   * Chỉ là **gợi ý**: C-2 đọc lệnh, C-3 thêm `targets` vào đích, C-4 thấy op đề xuất của vị trí — mọi nút vẫn chạy.
   */
  seed: CrSeed | null
  /** Version tài liệu lúc tạo CR; ghi Track Changes lên version mới nhất lúc write. */
  base_doc_version: string
  result_doc_version: string | null
  created_by: mongoose.Types.ObjectId
  submitted_at: Date | null
  decided_by: mongoose.Types.ObjectId | null
  /** Lý do khi `rejected` (đóng) hoặc `cancelled` (huỷ). */
  closed_reason: string | null
  createdAt: Date
  updatedAt: Date
}

export interface CrSeed {
  instruction: string | null
  ops: Record<string, unknown>[]
  /** Phần tử Spine bị op chạm (`actors[id=A01]`, `project`). */
  targets: string[]
}

const opts = { _id: false }

const changeRequestSchema = new Schema<IChangeRequest>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    cr_id: { type: String, required: true, match: CR_ID_PATTERN },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, required: true, trim: true, maxlength: 5000 },
    source: {
      type: new Schema(
        {
          kind: { type: String, enum: CR_SOURCE_KINDS, required: true },
          ref: { type: String, default: null },
          note: { type: String, default: null }
        },
        opts
      ),
      required: true
    },
    requester: { type: String, required: true, trim: true },
    status: { type: String, enum: CR_STATUSES, default: "draft" },
    paused: {
      type: new Schema({ reason: { type: String, enum: CR_PAUSE_REASONS, required: true }, at: { type: Date, required: true } }, opts),
      default: null
    },
    clarifications: {
      type: [new Schema({ round: { type: Number, required: true, min: 1 }, questions: [String], answers: [String] }, opts)],
      default: []
    },
    targets: {
      type: new Schema({ entity_paths: { type: [String], default: [] }, keywords: { type: [String], default: [] } }, opts),
      default: () => ({ entity_paths: [], keywords: [] })
    },
    seed: {
      type: new Schema({ instruction: { type: String, default: null }, ops: { type: [Schema.Types.Mixed], default: [] }, targets: { type: [String], default: [] } }, opts),
      default: null
    },
    base_doc_version: { type: String, required: true },
    result_doc_version: { type: String, default: null },
    created_by: { type: Schema.Types.ObjectId, ref: "User", required: true },
    submitted_at: { type: Date, default: null },
    decided_by: { type: Schema.Types.ObjectId, ref: "User", default: null },
    closed_reason: { type: String, default: null }
  },
  { timestamps: true }
)

changeRequestSchema.index({ projectId: 1, cr_id: 1 }, { unique: true })
changeRequestSchema.index({ projectId: 1, status: 1 })

export const ChangeRequest = mongoose.model<IChangeRequest>("ChangeRequest", changeRequestSchema)

/** Bộ đếm `cr_id` theo project — `findOneAndUpdate({$inc: {seq: 1}}, {upsert, new})` là nguyên tử. */
export interface ICrCounter extends Document {
  projectId: mongoose.Types.ObjectId
  seq: number
}

const crCounterSchema = new Schema<ICrCounter>({
  projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
  seq: { type: Number, default: 0, min: 0 }
})

crCounterSchema.index({ projectId: 1 }, { unique: true })

export const CrCounter = mongoose.model<ICrCounter>("CrCounter", crCounterSchema)
