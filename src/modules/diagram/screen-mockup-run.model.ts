import mongoose, { Schema, type Document } from "mongoose"
import { SCREEN_MOCKUP_MODES, type ScreenMockupMode } from "../../shared/diagram/screen-theme.js"

export const SCREEN_MOCKUP_RUN_STATUSES = ["running", "done", "cancelled"] as const
export type ScreenMockupRunStatus = (typeof SCREEN_MOCKUP_RUN_STATUSES)[number]

/**
 * Một lượt "Vẽ lại bằng mockup" chạy nền (FLF-410): màn cần model vẽ (kiểu đã chốt), tiến độ từng màn, yêu cầu dừng. Ngoài
 * Spine — chỉ là trạng thái tiến trình để FE hỏi định kỳ; mockup thật ghi vào `diagrams[]` từng màn một.
 */
export interface IScreenMockupRun extends Document {
  projectId: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  status: ScreenMockupRunStatus
  /** Màn cần model vẽ, theo thứ tự chạy. */
  screens: { screen_id: string; mode: ScreenMockupMode }[]
  /** Màn đã có mockup (kể cả màn bật lại 0 credit lúc bắt đầu). */
  done: string[]
  failed: { screen_id: string; reason: string }[]
  fell_back_to_system: string[]
  /** Màu theme lúc bắt đầu — `null` ⇒ màu ảnh gốc tự vào theme. */
  theme_color: string | null
  suggested_color: string | null
  /** Người dùng bấm Dừng: màn đang vẽ xong thì dừng. */
  cancel_requested: boolean
  createdAt: Date
  updatedAt: Date
}

const runSchema = new Schema<IScreenMockupRun>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    status: { type: String, enum: [...SCREEN_MOCKUP_RUN_STATUSES], default: "running" },
    screens: {
      type: [new Schema({ screen_id: { type: String, required: true }, mode: { type: String, enum: [...SCREEN_MOCKUP_MODES], required: true } }, { _id: false })],
      default: []
    },
    done: { type: [String], default: [] },
    failed: { type: [new Schema({ screen_id: { type: String, required: true }, reason: { type: String, required: true } }, { _id: false })], default: [] },
    fell_back_to_system: { type: [String], default: [] },
    theme_color: { type: String, default: null },
    suggested_color: { type: String, default: null },
    cancel_requested: { type: Boolean, default: false }
  },
  { timestamps: true }
)

runSchema.index({ projectId: 1, createdAt: -1 })

export const ScreenMockupRun = mongoose.model<IScreenMockupRun>("ScreenMockupRun", runSchema)
