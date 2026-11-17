/**
 * google-export.service.ts
 * ─────────────────────────────────────────────────────────────────
 * Xuất tài liệu sang Google Docs: upload đúng file `.docx` của `GET /export/word` lên Drive, Drive tự chuyển sang
 * Google Docs (metadata `mimeType` = Google Docs, media giữ MIME của Word). "Cập nhật" gọi `files.update` có media
 * ⇒ thay toàn bộ nội dung file cũ, link giữ nguyên.
 *
 * Bản Word vẫn là bản chính thức; Google Docs là bản để xem và cộng tác.
 */
import { Readable } from "node:stream"
import { drive as createDrive, type drive_v3 } from "@googleapis/drive"
import type { OAuth2Client } from "google-auth-library"
import { GoogleDocLink, type GoogleDocSource, type IGoogleDocLink } from "./google-doc-link.model.js"
import { googleErrorStatus, toGoogleApiError } from "./google-api-error.js"

export const GOOGLE_DOC_MIME = "application/vnd.google-apps.document"
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
const FILE_FIELDS = "id,name,webViewLink"

export type GoogleExportMode = "new" | "update"

export interface GoogleExportInput {
  auth: OAuth2Client
  projectId: string
  userId: string
  docx: Buffer
  fileName: string
  source: GoogleDocSource
  baselineId: string | null
  lang: string
  /** `update`: ghi đè Google Doc xuất gần nhất cùng nguồn + ngôn ngữ; chưa có thì tạo mới. */
  mode: GoogleExportMode
}

export interface GoogleExportResult {
  fileId: string
  webViewLink: string
  title: string
  /** Việc đã làm thật: `update` chỉ khi đã ghi đè một file có sẵn. */
  mode: GoogleExportMode
  /** Muốn cập nhật nhưng file cũ đã bị xoá / vào thùng rác ⇒ đã tạo file mới. */
  recreated: boolean
}

export interface GoogleDocLinkView {
  fileId: string
  title: string
  webViewLink: string
  source: GoogleDocSource
  lang: string
  baselineId: string | null
  exportedAt: Date
}

const toView = (link: IGoogleDocLink): GoogleDocLinkView => ({
  fileId: link.fileId,
  title: link.title,
  webViewLink: link.webViewLink,
  source: link.source,
  lang: link.lang,
  baselineId: link.baselineId,
  exportedAt: link.exportedAt
})

/** File còn dùng được (tồn tại, chưa vào thùng rác) ⇒ `true`. 404 ⇒ `false`; lỗi khác ném lên. */
const isUsable = async (drive: drive_v3.Drive, fileId: string): Promise<boolean> => {
  try {
    const { data } = await drive.files.get({ fileId, fields: "id,trashed" })
    return !data.trashed
  } catch (err) {
    if (googleErrorStatus(err) === 404) return false
    throw err
  }
}

export const exportToGoogleDocs = async (input: GoogleExportInput): Promise<GoogleExportResult> => {
  const { auth, projectId, userId, docx, fileName, source, baselineId, lang, mode } = input
  const drive = createDrive({ version: "v3", auth })
  const title = fileName.replace(/\.docx$/i, "")
  const media = () => ({ mimeType: DOCX_MIME, body: Readable.from(docx) })

  const previous =
    mode === "update"
      ? await GoogleDocLink.findOne({ projectId, userId, source, baselineId, lang }).sort({ exportedAt: -1 })
      : null

  let file: drive_v3.Schema$File
  let updated = false
  try {
    if (previous && (await isUsable(drive, previous.fileId))) {
      file = (await drive.files.update({ fileId: previous.fileId, requestBody: { name: title }, media: media(), fields: FILE_FIELDS })).data
      updated = true
    } else {
      file = (await drive.files.create({ requestBody: { name: title, mimeType: GOOGLE_DOC_MIME }, media: media(), fields: FILE_FIELDS })).data
    }
  } catch (err) {
    throw toGoogleApiError(err)
  }
  if (!file.id || !file.webViewLink) throw new Error("Drive không trả id / webViewLink cho file vừa xuất")

  const fields = { fileId: file.id, title: file.name ?? title, webViewLink: file.webViewLink, exportedAt: new Date() }
  if (previous) {
    // Cập nhật hoặc tạo lại thay file đã mất ⇒ vẫn là "file của nguồn này", không thêm link thứ hai
    await GoogleDocLink.updateOne({ _id: previous._id }, { $set: fields })
  } else {
    await GoogleDocLink.create({ projectId, userId, source, baselineId, lang, ...fields })
  }

  return {
    fileId: fields.fileId,
    webViewLink: fields.webViewLink,
    title: fields.title,
    mode: updated ? "update" : "new",
    recreated: Boolean(previous) && !updated
  }
}

/** Google Doc user này đã xuất trong dự án, mới nhất trước. */
export const listLinks = async (projectId: string, userId: string): Promise<GoogleDocLinkView[]> => {
  const links = await GoogleDocLink.find({ projectId, userId }).sort({ exportedAt: -1 }).limit(50)
  return links.map(toView)
}
