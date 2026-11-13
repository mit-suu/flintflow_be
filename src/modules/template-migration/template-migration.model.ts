/**
 * Một lần đổi mẫu của dự án sau baseline (xuôi hoặc ngược). Bước chuẩn bị (mapping → ghép mục → phân nhóm → quyết định) chỉ ghi
 * collection này, chưa đụng bản nháp. Trạng thái:
 *   mapping_review → decisions → ready → applying → applied → reverting → reverted | cancelled | failed
 * `applying` chạy quá số lần phục hồi ⇒ `apply_failed` (giữ snapshot, chờ "khôi phục từ snapshot" ⇒ `failed`).
 * Huỷ được trước `applying`; `applying` kẹt thì job phục hồi (`recover-applying.ts`) chạy tiếp hoặc trả về `ready`. `ready` ghim `prepared_spine_version` + `prepared_source_sha256` để bước áp dụng biết dữ liệu có đổi không.
 */
import mongoose, { Schema, Document } from "mongoose"
import type { Op } from "../spine/op.types.js"
import type { MigrationGroups, TableShape } from "./classify.js"
import type { EditedSection } from "./edited-since.js"
import type { NewHeading, OldHeading, PairingResult } from "./pair-sections.js"

export const MIGRATION_STATES = ["mapping_review", "decisions", "ready", "applying", "apply_failed", "applied", "reverting", "reverted", "cancelled", "failed"] as const
export type MigrationState = (typeof MIGRATION_STATES)[number]

/** Chưa kết thúc: còn giữ chỗ của dự án, chặn xoá bản mẫu đích. */
export const OPEN_MIGRATION_STATES: readonly MigrationState[] = ["mapping_review", "decisions", "ready", "applying", "apply_failed", "reverting"]
export const isOpenState = (s: MigrationState): boolean => OPEN_MIGRATION_STATES.includes(s)

/**
 * Cách duy nhất ghi `state`: `open` luôn suy ra từ trạng thái mới, nên không nhánh nào quên giải phóng chỗ của dự án
 * (kể cả `applied` / `failed` ở bước áp dụng).
 */
export const stateUpdate = (state: MigrationState, fields: Record<string, unknown> = {}): Record<string, unknown> => ({ ...fields, state, open: isOpenState(state) })

export interface MigrationFrom {
  /** Mẫu org dự án đang theo (`null` = mẫu tự do / FPT). */
  template_ref: { template_id: mongoose.Types.ObjectId; version: number } | null
  source_file_ref: string | null
  source_sha256: string | null
  doc_version: string | null
  language: string
  template_family: string | null
  headings: OldHeading[]
}

export interface MigrationTo {
  template_id: mongoose.Types.ObjectId
  version: number
  name: string
  visibility: "org" | "project"
  file_ref: string
  sha256: string
  language: string
  template_family: string | null
  headings: NewHeading[]
}

export interface MigrationAnalysis {
  old_tables: Record<string, TableShape[]>
  new_tables: Record<string, TableShape[]>
  /** Đổi ngược: mục đã sửa sau lần đổi mẫu trước; `null` = đổi xuôi. */
  edited: EditedSection[] | null
}

/** Ảnh chụp trước khi áp dụng — đủ để khôi phục bản nháp về đúng trạng thái cũ (hoàn tác, phục hồi `applying`). */
export interface MigrationSnapshot {
  /** Toàn bộ `TemplateProfile` (lean) trước khi đổi; `null` = dự án chưa có profile (mode 2). */
  profile: Record<string, unknown> | null
  source_file_ref: string | null
  template_ref: { template_id: mongoose.Types.ObjectId; version: number } | null
  template_intent: string | null
  /** `Project.documentLanguage` trước khi đổi; `null` = field chưa đặt. */
  document_language: string | null
  /** Bản riêng của dự án đăng ký cho file nền cũ (đích của lần đổi ngược khi dự án từng theo mẫu tự do). */
  registered_ref: { template_id: mongoose.Types.ObjectId; version: number } | null
  /** Lần đổi mẫu đã áp dụng ngay trước lần này: nguồn của `migrated_base_spine` khi hoàn tác (snapshot không chứa bản sao Spine). */
  prior_anchor_migration_id: mongoose.Types.ObjectId | null
}

/** Bản dịch đã có của lần đổi mẫu (key đơn vị dịch ⇒ chữ dịch) — lưu để chạy lại không dịch (không trừ credit) lần hai. */
export interface MigrationTranslatedUnit {
  key: string
  source_hash: string
  text: string | string[]
}

export interface ApplySteps {
  snapshot: boolean
  file: boolean
  spine: boolean
  profile: boolean
}

export interface MigrationDecision {
  id: string
  choice: string
  at: Date
  by: mongoose.Types.ObjectId
}

export interface ITemplateMigration extends Document {
  projectId: mongoose.Types.ObjectId
  orgId: mongoose.Types.ObjectId
  state: MigrationState
  /** Đúng khi `state` chưa kết thúc — khoá duy nhất "mỗi dự án một lần đổi mẫu đang mở". */
  open: boolean
  direction: "forward" | "reverse"
  /** Đổi ngược: lần đổi mẫu đã áp dụng mà lần này quay về mẫu trước của nó. */
  reverse_of: mongoose.Types.ObjectId | null
  from: MigrationFrom
  to: MigrationTo
  pairing: PairingResult
  /** Dữ liệu đầu vào của `classify` ngoài heading — lưu để phân nhóm lại khi BA sửa cặp mà không đọc lại file. */
  analysis: MigrationAnalysis
  groups: MigrationGroups
  decisions: MigrationDecision[]
  needs_translation: boolean
  /** Mẫu đích khác ngôn ngữ nhưng dự án không giữ chữ của khách trong Spine (mode 2 / FPT): chỉ đổi `documentLanguage`. */
  language_switch_only: boolean
  /** Mẫu đích đọc được nhưng một phần (vd bảng của mẫu không đọc ra) — BA nên kiểm. */
  warnings: string[]
  /** Spine lúc chuẩn bị (thông tin) và mốc nội dung — đổi ngược dùng mốc này để biết có sửa thêm giữa chừng không. */
  base_spine_version: number
  base_content_seq: number
  prepared_spine_version: number | null
  prepared_source_sha256: string | null
  ready_at: Date | null
  /** Kết quả bước AI (D8) theo mục — lưu để áp dụng lại không gọi (không trừ credit) lần hai. */
  resolved_items: { id: string; original_choice: string; source_hash: string; choice: string; ops: Op[]; removed_custom_ids: string[]; notes: string | null }[]
  /** Đã chạy bước dịch (D9): Spine của dự án được ghi chữ đã dịch; phát hành đọc để không tạo bản tracked. */
  translated: boolean
  translated_units: MigrationTranslatedUnit[]
  snapshot: MigrationSnapshot | null
  /** File nền mới đã lưu ở bước áp dụng (xoá khi trả về `ready` / hoàn tác). */
  new_base_file_ref: string | null
  /** `cr_id` của CR nguồn `template_migration` mang các Change của lần này. */
  spine_cr_id: string | null
  /** Phần profile mô tả file nền mới (heading_map, table_map, layout…) — dựng ở bước dựng file, `$set` ở bước cuối. */
  new_profile: Record<string, unknown> | null
  /** Kế hoạch ghi Spine chốt ở bước dựng file: op + seq Change cần đảo — phục hồi ghi đúng bản này, không lập lại. */
  spine_plan: { ops: Op[] | null; ops_file_ref: string | null; revert_seqs: number[]; base_version: number } | null
  /** Spine sau khi đảo + ghi op theo kế hoạch — mốc "nguyên vẹn" của file nền mới (version đã phát hành tham chiếu qua id migration). */
  anchor_spine: Record<string, unknown> | null
  /** Token của lượt áp dụng / phục hồi đang giữ migration: mọi bước ghi kiểm token, lượt chậm bị thay thế sẽ dừng. */
  apply_token: string | null
  /** Số lần phục hồi đã chạy tiếp; quá giới hạn ⇒ `apply_failed`. */
  apply_attempts: number
  /** Lúc Spine được ghi xong — `applied_at` / `migrated_base_at` dùng đúng mốc này, kể cả khi phục hồi chạy tiếp. */
  spine_written_at: Date | null
  /** Bước áp dụng đã xong (phục hồi chạy tiếp từ đây). */
  apply_steps: ApplySteps
  /** Lần cuối bước áp dụng còn sống — job phục hồi chỉ động tới lần áp dụng im lặng quá lâu. */
  applying_heartbeat: Date | null
  /** Mục thiếu ghi vào profile (cũng nằm trên `TemplateProfile.migration_missing_sections`). */
  missing_sections: string[]
  applied_at: Date | null
  reverted_at: Date | null
  cancelled_at: Date | null
  created_by: mongoose.Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const opts = { _id: false }

const templateMigrationSchema = new Schema<ITemplateMigration>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    orgId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    state: { type: String, enum: MIGRATION_STATES, required: true, default: "mapping_review" },
    open: { type: Boolean, required: true, default: true },
    direction: { type: String, enum: ["forward", "reverse"], required: true },
    reverse_of: { type: Schema.Types.ObjectId, ref: "TemplateMigration", default: null },
    from: {
      type: new Schema(
        {
          template_ref: { type: new Schema({ template_id: { type: Schema.Types.ObjectId, required: true }, version: { type: Number, required: true } }, opts), default: null },
          source_file_ref: { type: String, default: null },
          source_sha256: { type: String, default: null },
          doc_version: { type: String, default: null },
          language: { type: String, required: true },
          template_family: { type: String, default: null },
          headings: { type: [Schema.Types.Mixed], default: [] }
        },
        opts
      ),
      required: true
    },
    to: {
      type: new Schema(
        {
          template_id: { type: Schema.Types.ObjectId, ref: "OrgTemplate", required: true },
          version: { type: Number, required: true },
          name: { type: String, default: "" },
          visibility: { type: String, enum: ["org", "project"], required: true },
          file_ref: { type: String, required: true },
          sha256: { type: String, required: true },
          language: { type: String, required: true },
          template_family: { type: String, default: null },
          headings: { type: [Schema.Types.Mixed], default: [] }
        },
        opts
      ),
      required: true
    },
    pairing: { type: Schema.Types.Mixed, required: true },
    analysis: { type: Schema.Types.Mixed, required: true },
    groups: { type: Schema.Types.Mixed, required: true },
    decisions: {
      type: [new Schema({ id: { type: String, required: true }, choice: { type: String, required: true }, at: { type: Date, required: true }, by: { type: Schema.Types.ObjectId, required: true } }, opts)],
      default: []
    },
    needs_translation: { type: Boolean, default: false },
    language_switch_only: { type: Boolean, default: false },
    warnings: { type: [String], default: [] },
    base_spine_version: { type: Number, required: true },
    base_content_seq: { type: Number, required: true },
    prepared_spine_version: { type: Number, default: null },
    prepared_source_sha256: { type: String, default: null },
    ready_at: { type: Date, default: null },
    resolved_items: { type: Schema.Types.Mixed, default: () => [] },
    translated: { type: Boolean, default: false },
    translated_units: { type: Schema.Types.Mixed, default: () => [] },
    snapshot: { type: Schema.Types.Mixed, default: null },
    new_base_file_ref: { type: String, default: null },
    new_profile: { type: Schema.Types.Mixed, default: null },
    spine_plan: { type: Schema.Types.Mixed, default: null },
    anchor_spine: { type: Schema.Types.Mixed, default: null },
    apply_token: { type: String, default: null },
    apply_attempts: { type: Number, default: 0 },
    spine_written_at: { type: Date, default: null },
    spine_cr_id: { type: String, default: null },
    apply_steps: { type: Schema.Types.Mixed, default: () => ({ snapshot: false, file: false, spine: false, profile: false }) },
    applying_heartbeat: { type: Date, default: null },
    missing_sections: { type: [String], default: [] },
    applied_at: { type: Date, default: null },
    reverted_at: { type: Date, default: null },
    cancelled_at: { type: Date, default: null },
    created_by: { type: Schema.Types.ObjectId, ref: "User", required: true }
  },
  { timestamps: true, collection: "template_migrations" }
)

// Mỗi dự án chỉ một lần đổi mẫu đang mở (chặn hai người bấm cùng lúc)
templateMigrationSchema.index({ projectId: 1 }, { unique: true, partialFilterExpression: { open: true } })
templateMigrationSchema.index({ projectId: 1, createdAt: -1 })
// Chặn xoá bản / họ mẫu đang được một lần đổi mẫu chưa kết thúc trỏ tới
templateMigrationSchema.index({ "to.template_id": 1, "to.version": 1, open: 1 })

export const TemplateMigration = mongoose.model<ITemplateMigration>("TemplateMigration", templateMigrationSchema)
