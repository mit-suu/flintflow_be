import mongoose, { Schema, Document } from "mongoose"

export const GOOGLE_DOC_SOURCES = ["draft", "baseline"] as const
export type GoogleDocSource = (typeof GOOGLE_DOC_SOURCES)[number]

/**
 * Một Google Doc đã xuất từ dự án. Lưu theo cặp (dự án, người dùng) vì quyền `drive.file` gắn theo từng tài khoản
 * Google: file do người A tạo thì người B không cập nhật được.
 *
 * "Cập nhật file cũ" ghi đè bản mới nhất có cùng `source` + `baselineId` + `lang`.
 */
export interface IGoogleDocLink extends Document {
  projectId: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  fileId: string
  title: string
  webViewLink: string
  source: GoogleDocSource
  lang: string
  baselineId: string | null
  exportedAt: Date
  createdAt: Date
  updatedAt: Date
}

const googleDocLinkSchema = new Schema<IGoogleDocLink>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    fileId: { type: String, required: true },
    title: { type: String, required: true },
    webViewLink: { type: String, required: true },
    source: { type: String, enum: GOOGLE_DOC_SOURCES, required: true },
    lang: { type: String, required: true },
    baselineId: { type: String, default: null },
    exportedAt: { type: Date, required: true }
  },
  { timestamps: true }
)

googleDocLinkSchema.index({ projectId: 1, userId: 1, exportedAt: -1 })

export const GoogleDocLink = mongoose.model<IGoogleDocLink>("GoogleDocLink", googleDocLinkSchema)
