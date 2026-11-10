/**
 * FLF-278 trên FLF-335/336 — dữ liệu cấp tổ chức, dùng lại qua nhiều dự án theo mẫu khách:
 *  - `OrgTemplate` (họ mẫu) + `OrgTemplateVersion` (FLF-395: từng bản file mẫu + mapping heading). Dự án chọn mẫu ⇒ import
 *    từ đúng file của bản đó, mapping áp sẵn.
 *  - `OrgContentEntry`: nội dung chuẩn của tổ chức theo tiêu đề mục (Document Conventions, References…). Chỉ là nguồn gợi ý —
 *    vào Spine qua bản xem trước / change request, không ghi thẳng.
 */
import mongoose, { Schema, type Document } from "mongoose"
import type { CustomBlock } from "../spine/spine.types.js"

const opts = { _id: false, strict: "throw" as const }

export interface OrgTemplateHeading {
  heading_text: string
  section_id: string
  /** FLF-395: mapping tự nhận độ tin thấp lúc đăng bản mới — Lead nên rà. */
  auto_confirmed?: boolean
  /** FLF-395: chữ hướng dẫn của mẫu dưới heading (đọc từ file mẫu). */
  guidance?: string
}

/** FLF-395: mapping cột bảng của mẫu (không giữ dữ liệu mẫu `samples`). */
export interface OrgTemplateColumn {
  block_id: string
  column_index: number
  header: string
  field_path: string | null
}

const sourceFileSchema = new Schema(
  { name: { type: String, required: true }, size: { type: Number, required: true, min: 0 }, sha256: { type: String, required: true, match: /^[a-f0-9]{64}$/ } },
  opts
)
const headingSchema = new Schema(
  {
    heading_text: { type: String, required: true },
    section_id: { type: String, required: true },
    auto_confirmed: { type: Boolean, default: undefined },
    guidance: { type: String, default: undefined }
  },
  opts
)

/**
 * "Họ mẫu" của tổ chức (FLF-395). File + mapping nằm ở từng bản `OrgTemplateVersion`. Các field file / mapping ở đây chỉ có
 * trên bản ghi cũ trước FLF-395: `version_seq = 0` ⇒ đọc như bản 1; đã tạo bản 1 thật thì giữ nguyên (không đọc nữa) để bản
 * deploy cũ vẫn đọc được khi phải rollback.
 */
export interface IOrgTemplate extends Document {
  orgId: mongoose.Types.ObjectId
  name: string
  /** Bản org đã đăng mới nhất; 0 = chưa có bản nào (bản ghi cũ chưa migrate / chỉ có bản nháp). */
  latest_version: number
  /** Số bản đã cấp (chỉ tăng) — bản mới lấy số kế tiếp, xoá bản không làm số bị dùng lại. 0 = chưa cấp bản nào. */
  version_seq: number
  /** FLF-395 (D12): mẫu khung tự lưu từ dự án này (dự án mẫu tự do sau baseline); `null` = mẫu Lead đăng. */
  skeleton_of: mongoose.Types.ObjectId | null
  /** Họ ẩn của riêng một dự án (file Analyst tải lên khi đổi mẫu): không hiện ở thư viện, route thư viện không nhắm tới được; `null` = họ của thư viện. */
  project_id: mongoose.Types.ObjectId | null
  created_by: mongoose.Types.ObjectId
  uses: number
  /** Bản ghi cũ (trước FLF-395). */
  source_file?: { name: string; size: number; sha256: string }
  file_ref?: string
  template_family?: string
  headings?: OrgTemplateHeading[]
  createdAt: Date
  updatedAt: Date
}

const orgTemplateSchema = new Schema<IOrgTemplate>(
  {
    orgId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    latest_version: { type: Number, default: 0, min: 0 },
    version_seq: { type: Number, default: 0, min: 0 },
    skeleton_of: { type: Schema.Types.ObjectId, ref: "Project", default: null },
    project_id: { type: Schema.Types.ObjectId, ref: "Project", default: null },
    created_by: { type: Schema.Types.ObjectId, ref: "User", required: true },
    uses: { type: Number, default: 0, min: 0 },
    source_file: { type: sourceFileSchema, default: undefined },
    file_ref: { type: String, default: undefined },
    template_family: { type: String, default: undefined },
    headings: { type: [headingSchema], default: undefined }
  },
  { timestamps: true, collection: "org_templates" }
)

export const OrgTemplate = mongoose.model<IOrgTemplate>("OrgTemplate", orgTemplateSchema)

export const PENDING_DECISIONS = ["pending", "keep", "generic", "drop"] as const
export type PendingHeadingDecision = (typeof PENDING_DECISIONS)[number]

/**
 * FLF-395 (D13): heading chờ duyệt trước khi vào khung mẫu (khoá = `block_id` heading trong file nguồn của bản khung): mục BA
 * tự đặt (`custom`) hoặc heading mẫu chuẩn có chữ khác tên chuẩn (`wording`).
 */
export interface SkeletonPendingHeading {
  key: string
  heading_text: string
  level: number
  kind: "custom" | "wording"
  /** Tên chuẩn ghi vào khung khi mục `wording` chưa duyệt. */
  standard_title: string | null
  /** Gợi ý dạng chung không AI (thay tên dự án) hoặc từ nút "Gợi ý tên chung". */
  suggestion: string | null
  /** Lý do AI cho rằng không dùng lại được (gợi ý bỏ). */
  suggestion_reason: string | null
  decision: PendingHeadingDecision
  /** Chữ heading khi chọn "giữ dạng chung". */
  generic_text: string | null
}

export const TEMPLATE_VERSION_STATUSES = ["draft", "published"] as const
export type TemplateVersionStatus = (typeof TEMPLATE_VERSION_STATUSES)[number]

/**
 * Một bản của mẫu (FLF-395, D2). `visibility = org`: hiện ở thư viện, chỉ tạo qua `publishVersion` (Lead). `project`: file
 * Analyst tải lên khi đổi mẫu cho riêng một dự án — không hiện ở thư viện, không thông báo. `draft`: Lead đang rà mapping
 * tự nhận, chưa dùng được. Bản cũ giữ mãi tới khi người dùng xoá.
 */
export interface IOrgTemplateVersion extends Document {
  template_id: mongoose.Types.ObjectId
  orgId: mongoose.Types.ObjectId
  version: number
  status: TemplateVersionStatus
  visibility: "org" | "project"
  project_id: mongoose.Types.ObjectId | null
  source_file: { name: string; size: number; sha256: string }
  /** File mẫu trong kho `docFileStore` (bản sao riêng — xoá dự án gốc không mất). */
  file_ref: string
  template_family: string | null
  language: string
  /** Mapping heading theo đúng thứ tự heading của file (cùng sha256 ⇒ cùng thứ tự). */
  headings: OrgTemplateHeading[]
  table_map: OrgTemplateColumn[]
  created_by: mongoose.Types.ObjectId
  published_at: Date | null
  /** FLF-395 (D12): dấu khung (cấp + heading chuẩn hoá + tiêu đề cột) của bản tự lưu — trùng thì không lưu bản mới. */
  skeleton_hash: string | null
  /** File tài liệu (bản phát hành) dựng ra khung này — dựng lại khi duyệt heading. */
  skeleton_source_ref: string | null
  pending_headings: SkeletonPendingHeading[]
  createdAt: Date
  updatedAt: Date
}

const orgTemplateVersionSchema = new Schema<IOrgTemplateVersion>(
  {
    template_id: { type: Schema.Types.ObjectId, ref: "OrgTemplate", required: true },
    orgId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    version: { type: Number, required: true, min: 1 },
    status: { type: String, enum: TEMPLATE_VERSION_STATUSES, required: true },
    visibility: { type: String, enum: ["org", "project"], required: true },
    project_id: { type: Schema.Types.ObjectId, ref: "Project", default: null },
    source_file: { type: sourceFileSchema, required: true },
    file_ref: { type: String, required: true },
    template_family: { type: String, default: null },
    language: { type: String, default: "en" },
    headings: { type: [headingSchema], required: true },
    table_map: {
      type: [
        new Schema(
          { block_id: { type: String, required: true }, column_index: { type: Number, required: true, min: 0 }, header: { type: String, default: "" }, field_path: { type: String, default: null } },
          opts
        )
      ],
      default: []
    },
    created_by: { type: Schema.Types.ObjectId, ref: "User", required: true },
    published_at: { type: Date, default: null },
    skeleton_hash: { type: String, default: null },
    skeleton_source_ref: { type: String, default: null },
    pending_headings: {
      type: [
        new Schema(
          {
            key: { type: String, required: true },
            heading_text: { type: String, required: true },
            level: { type: Number, required: true },
            kind: { type: String, enum: ["custom", "wording"], default: "custom" },
            standard_title: { type: String, default: null },
            suggestion: { type: String, default: null },
            suggestion_reason: { type: String, default: null },
            decision: { type: String, enum: PENDING_DECISIONS, default: "pending" },
            generic_text: { type: String, default: null }
          },
          opts
        )
      ],
      default: []
    }
  },
  { timestamps: true, collection: "org_template_versions" }
)
orgTemplateVersionSchema.index({ template_id: 1, version: 1 }, { unique: true })
orgTemplateVersionSchema.index({ orgId: 1, template_id: 1, status: 1 })
orgTemplateVersionSchema.index({ orgId: 1, skeleton_hash: 1 }, { sparse: true })

export const OrgTemplateVersion = mongoose.model<IOrgTemplateVersion>("OrgTemplateVersion", orgTemplateVersionSchema)

export interface IOrgContentEntry extends Document {
  orgId: mongoose.Types.ObjectId
  title: string
  /** Tiêu đề đã chuẩn hoá (`normalizeTitle`) — unique theo org. */
  key: string
  blocks: CustomBlock[]
  updated_by: mongoose.Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const orgContentSchema = new Schema<IOrgContentEntry>(
  {
    orgId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    key: { type: String, required: true },
    blocks: {
      type: [
        new Schema(
          {
            kind: { type: String, enum: ["paragraph", "list_item"], required: true },
            text: { type: String, required: true, maxlength: 4000 },
            rows: { type: Schema.Types.Mixed, default: null },
            image_ref: { type: String, default: null }
          },
          opts
        )
      ],
      required: true
    },
    updated_by: { type: Schema.Types.ObjectId, ref: "User", required: true }
  },
  { timestamps: true, collection: "org_content_entries" }
)
orgContentSchema.index({ orgId: 1, key: 1 }, { unique: true })

export const OrgContentEntry = mongoose.model<IOrgContentEntry>("OrgContentEntry", orgContentSchema)
