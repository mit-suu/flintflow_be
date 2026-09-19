import mongoose, { Schema, Document } from "mongoose"
import { IMPORT_STATUSES, type ImportStatus } from "../import/import.state.js"

export type ProjectStatus = "active" | "archived"

/**
 * Cách làm SRS của project (FLF-171) — KHÁC `spine.project.working_mode` (fast/coaching là nhịp hỏi đáp
 * trong quy trình sinh SRS):
 * - `import` — mode 1: upload SRS có sẵn rồi sửa qua change request.
 * - `fpt` — mode 2: sinh SRS theo template FPT qua 12 phase (luồng hiện có). Project cũ không có field ⇒ `fpt`.
 * - `customer_template` — mode 3: template khách hàng, chưa làm (tạo mới trả 501).
 */
export const PROJECT_MODES = ["import", "fpt", "customer_template"] as const
export type ProjectMode = (typeof PROJECT_MODES)[number]

export interface IProject extends Document {
  userId: mongoose.Types.ObjectId
  name: string
  domain?: string | null
  status: ProjectStatus
  mode: ProjectMode
  /** Mode 1: bản sao rút gọn `ImportedDocument.status` để hiện danh sách (UC-14, UC-19); mode khác luôn `null`. */
  import_state: ImportStatus | null
  /** Thư mục chứa dự án (`modules/folder`); null = ngoài thư mục. */
  folderId: mongoose.Types.ObjectId | null
  /** Lần gần nhất user mở dự án (GET /projects/:id) — sắp xếp "Mới mở" trên dashboard. */
  lastOpenedAt: Date | null
  // Nội dung, tiến độ, baseline đều nằm ở Spine (modules/spine) — Project chỉ giữ metadata danh sách.
  createdAt: Date
  updatedAt: Date
}

const projectSchema = new Schema<IProject>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true
    },
    name: {
      type: String,
      required: true,
      trim: true
    },
    domain: {
      type: String,
      default: null,
      trim: true
    },
    status: {
      type: String,
      enum: ["active", "archived"],
      default: "active"
    },
    mode: {
      type: String,
      enum: PROJECT_MODES,
      default: "fpt"
    },
    import_state: {
      type: String,
      enum: [...IMPORT_STATUSES, null],
      default: null
    },
    folderId: {
      type: Schema.Types.ObjectId,
      ref: "Folder",
      default: null
    },
    lastOpenedAt: {
      type: Date,
      default: null
    }
  },
  { timestamps: true }
)

// Compound Index for dashboard list queries (UC06)
projectSchema.index({ userId: 1, status: 1 })

export const Project = mongoose.model<IProject>("Project", projectSchema)
