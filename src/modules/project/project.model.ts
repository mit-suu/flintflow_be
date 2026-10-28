import mongoose, { Schema, Document } from "mongoose"
import { IMPORT_STATUSES, type ImportStatus } from "../import/import.state.js"
import { USER_LOCALES, type UserLocale } from "../../shared/i18n/locale.js"

export type ProjectStatus = "active" | "archived"

/**
 * Cách làm SRS của project (FLF-171) — KHÁC `spine.project.working_mode` (fast/coaching là nhịp hỏi đáp
 * trong quy trình sinh SRS). Từ FLF-335 (business-flow §1) **Code suy ra** từ lựa chọn lúc tạo, client không gửi:
 * - `import` — tải file lên (SRS có sẵn, hoặc mẫu bắt buộc của dự án mới) rồi so cấu trúc đích ⇒ chế độ 1 / 3 / 4.
 * - `fpt` — dự án mới không mẫu: sinh SRS theo mẫu chuẩn FlintFlow (mẫu FPT) qua 12 phase. Project cũ không có field ⇒ `fpt`.
 * - `customer_template` — giá trị cũ (mode 3 chưa làm, từng trả 501); không còn được tạo, client cũ gửi lên được quy về `import`.
 */
export const PROJECT_MODES = ["import", "fpt", "customer_template"] as const
export type ProjectMode = (typeof PROJECT_MODES)[number]

/** FLF-335: lựa chọn duy nhất lúc tạo — dự án mới hay dự án có sẵn. */
export const PROJECT_START_KINDS = ["new", "existing"] as const
export type ProjectStartKind = (typeof PROJECT_START_KINDS)[number]
/** FLF-335: ý định với file tải lên (bước 1.2) — theo một mẫu cố định (mẫu khách / công ty) hay cấu trúc tự do. */
export const TEMPLATE_INTENTS = ["fixed", "free"] as const
export type TemplateIntent = (typeof TEMPLATE_INTENTS)[number]

export interface IProject extends Document {
  userId: mongoose.Types.ObjectId
  /** Org sở hữu dự án (task-26). null = dữ liệu có trước org, chờ migration backfill. */
  organizationId: mongoose.Types.ObjectId | null
  name: string
  domain?: string | null
  status: ProjectStatus
  mode: ProjectMode
  /** FLF-335: lựa chọn lúc tạo; dự án cũ `null`. */
  start_kind: ProjectStartKind | null
  /** FLF-335: dự án mới — khách có bắt buộc theo mẫu không; dự án có sẵn / cũ `null`. */
  has_required_template: boolean | null
  /** FLF-335: `fixed` ngay lúc tạo với dự án mới có mẫu bắt buộc; dự án có sẵn ghi lúc upload (#2 `intent`); cũ `null`. */
  template_intent: TemplateIntent | null
  /** Mode 1: bản sao rút gọn `ImportedDocument.status` để hiện danh sách (UC-14, UC-19); mode khác luôn `null`. */
  import_state: ImportStatus | null
  /**
   * FLF-318: dự án tạo SRS (`fpt`) đã được Lead ký baseline và chuyển sang `mode = import` (quản lý thay đổi qua CR).
   * `null` = dự án import thật hoặc chưa chuyển. Chữ trong Spine vẫn là tiếng Anh như mode 2 (`document-language.ts`).
   */
  converted_from: "fpt" | null
  converted_at: Date | null
  /**
   * Ngôn ngữ xem trước + .docx (FLF-265). Không default: thiếu field là có nghĩa (dự án cũ; mode 1 theo file upload)
   * ⇒ đọc qua `documentLanguageOf` (`document-language.ts`), đừng đọc thẳng.
   */
  documentLanguage?: UserLocale
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
    /**
     * Org sở hữu (task-26 Pha 0). Nullable ở pha này để migration backfill dần và API cũ chạy y nguyên;
     * Pha 4 đổi filter sang organizationId rồi mới bỏ nullable.
     */
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      default: null,
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
    start_kind: {
      type: String,
      enum: [...PROJECT_START_KINDS, null],
      default: null
    },
    has_required_template: {
      type: Boolean,
      default: null
    },
    template_intent: {
      type: String,
      enum: [...TEMPLATE_INTENTS, null],
      default: null
    },
    import_state: {
      type: String,
      enum: [...IMPORT_STATUSES, null],
      default: null
    },
    converted_from: {
      type: String,
      enum: ["fpt", null],
      default: null
    },
    converted_at: {
      type: Date,
      default: null
    },
    // FLF-265: KHÔNG default — dự án cũ / mode 1 không có field, giá trị suy ra ở `documentLanguageOf`
    documentLanguage: {
      type: String,
      enum: [...USER_LOCALES]
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
// Cùng truy vấn danh sách nhưng theo org (task-26 Pha 4 sẽ thay index theo userId ở trên)
projectSchema.index({ organizationId: 1, status: 1 })

export const Project = mongoose.model<IProject>("Project", projectSchema)
