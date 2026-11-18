import mongoose, { Schema, Document } from "mongoose"

export const GOOGLE_DOC_SOURCES = ["draft", "baseline"] as const
export type GoogleDocSource = (typeof GOOGLE_DOC_SOURCES)[number]

/** `export`: FlintFlow tạo file khi xuất. `linked`: Google Doc có sẵn được liên kết vào dự án — xuất không bao giờ ghi đè. */
export const GOOGLE_DOC_KINDS = ["export", "linked"] as const
export type GoogleDocKind = (typeof GOOGLE_DOC_KINDS)[number]

/**
 * Một Google Doc thuộc dự án. `userId` là người tạo / liên kết — quyền `drive.file` gắn theo từng tài khoản Google nên chỉ
 * người đó cập nhật được file và dùng trợ lý trên file; thành viên khác vẫn thấy link trong danh sách của dự án.
 *
 * "Cập nhật file cũ" ghi đè bản `export` mới nhất của chính user, cùng `source` + `baselineId` + `lang`.
 * Bản ghi trước khi có `kind` không mang field này ⇒ coi là `export` (lọc bằng `kind: { $ne: "linked" }`).
 */
export interface IGoogleDocLink extends Document {
  projectId: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  kind: GoogleDocKind
  fileId: string
  title: string
  webViewLink: string
  /** Chỉ bản `export`. */
  source: GoogleDocSource | null
  lang: string | null
  baselineId: string | null
  /** Lần xuất / liên kết gần nhất. */
  exportedAt: Date
  /** `spine_version` của nội dung đã xuất (bản nháp) ⇒ Spine đi tiếp thì Doc "cũ hơn web". */
  exportedSpineVersion: number | null
  /** `version` của file trên Drive ngay sau lần ghi của FlintFlow ⇒ lớn hơn nghĩa là đã bị sửa trong Google Docs. */
  driveVersion: string | null
  /** Thư mục `FlintFlow / <dự án>` chứa file (null khi file nằm chỗ khác). */
  folderId: string | null
  folderPath: string | null
  createdAt: Date
  updatedAt: Date
}

const googleDocLinkSchema = new Schema<IGoogleDocLink>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    kind: { type: String, enum: GOOGLE_DOC_KINDS, default: "export" },
    fileId: { type: String, required: true },
    title: { type: String, required: true },
    webViewLink: { type: String, required: true },
    source: { type: String, enum: [...GOOGLE_DOC_SOURCES, null], default: null },
    lang: { type: String, default: null },
    baselineId: { type: String, default: null },
    exportedAt: { type: Date, required: true },
    exportedSpineVersion: { type: Number, default: null },
    driveVersion: { type: String, default: null },
    folderId: { type: String, default: null },
    folderPath: { type: String, default: null }
  },
  { timestamps: true }
)

googleDocLinkSchema.index({ projectId: 1, userId: 1, exportedAt: -1 })
googleDocLinkSchema.index({ projectId: 1, fileId: 1 })

export const GoogleDocLink = mongoose.model<IGoogleDocLink>("GoogleDocLink", googleDocLinkSchema)
