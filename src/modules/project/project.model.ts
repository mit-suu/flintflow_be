import mongoose, { Schema, Document } from "mongoose"

export type ProjectStatus = "active" | "archived"

/**
 * Nguồn khởi đầu của dự án — quyết định nhánh BPMN (gateway "Working mode?"):
 *   edit_srs          Flow 1: upload SRS có sẵn để kiểm tra và sửa
 *   fpt_template      Flow 2.1: viết SRS mới trên mẫu FPT (luồng cũ — dự án trước migration đều là loại này)
 *   customer_template Flow 2.2: viết SRS mới theo template khách upload
 * Chọn một lần khi tạo, không đổi được sau đó. Khác `working_mode` (fast/coaching) trong Spine.
 */
export const SOURCE_MODES = ["edit_srs", "fpt_template", "customer_template"] as const
export type ProjectSourceMode = (typeof SOURCE_MODES)[number]

export interface IProject extends Document {
  userId: mongoose.Types.ObjectId
  name: string
  domain?: string | null
  status: ProjectStatus
  sourceMode: ProjectSourceMode
  /** Thư mục chứa dự án (`modules/folder`); null = ngoài thư mục. */
  folderId: mongoose.Types.ObjectId | null
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
    sourceMode: {
      type: String,
      enum: SOURCE_MODES,
      required: true
    },
    folderId: {
      type: Schema.Types.ObjectId,
      ref: "Folder",
      default: null
    }
  },
  { timestamps: true }
)

// Compound Index for dashboard list queries (UC06)
projectSchema.index({ userId: 1, status: 1 })

export const Project = mongoose.model<IProject>("Project", projectSchema)
