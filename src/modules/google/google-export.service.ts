/**
 * google-export.service.ts
 * ─────────────────────────────────────────────────────────────────
 * Xuất tài liệu sang Google Docs: upload đúng file `.docx` của `GET /export/word` lên Drive, Drive tự chuyển sang
 * Google Docs (metadata `mimeType` = Google Docs, media giữ MIME của Word). "Cập nhật" gọi `files.update` có media
 * ⇒ thay toàn bộ nội dung file cũ, link giữ nguyên.
 *
 * File nằm trong thư mục app tự tạo `FlintFlow / <Tên dự án>`. Với quyền `drive.file` app chỉ đọc được thư mục do chính
 * nó tạo ⇒ hai thư mục được đánh dấu bằng `appProperties` và tìm lại qua `files.list`, không lưu id ở DB.
 *
 * Bản Word vẫn là bản chính thức; Google Docs là bản để xem và cộng tác.
 */
import { Readable } from "node:stream"
import { drive as createDrive, type drive_v3 } from "@googleapis/drive"
import type { OAuth2Client } from "google-auth-library"
import { GoogleDocLink, type GoogleDocSource } from "./google-doc-link.model.js"
import { googleErrorStatus, toGoogleApiError } from "./google-api-error.js"
import { ApiError } from "../../shared/utils/api-error.js"

export const GOOGLE_DOC_MIME = "application/vnd.google-apps.document"
export const FOLDER_MIME = "application/vnd.google-apps.folder"
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
const FILE_FIELDS = "id,name,webViewLink,version,parents"
const ROOT_FOLDER_NAME = "FlintFlow"
const ROOT_PROPERTY = "flintflowRoot"
const PROJECT_PROPERTY = "flintflowProjectId"

export type GoogleExportMode = "new" | "update"

export interface DriveFolder {
  id: string
  /** Ví dụ `FlintFlow / Hệ thống đặt lịch`. */
  path: string
  url: string
}

export const folderUrl = (folderId: string): string => `https://drive.google.com/drive/folders/${folderId}`

export interface GoogleExportInput {
  auth: OAuth2Client
  projectId: string
  projectName: string
  userId: string
  docx: Buffer
  fileName: string
  source: GoogleDocSource
  baselineId: string | null
  lang: string
  /** `spine_version` của nội dung vừa dựng (bản nháp); baseline bất biến ⇒ `null`. */
  spineVersion: number | null
  /** `update`: ghi đè Google Doc xuất gần nhất cùng nguồn + ngôn ngữ; chưa có thì tạo mới. */
  mode: GoogleExportMode
  /** Ghi đè dù Google Doc đã bị sửa sau lần xuất trước (người dùng đã xác nhận). */
  force: boolean
}

export interface GoogleExportResult {
  fileId: string
  webViewLink: string
  title: string
  /** Việc đã làm thật: `update` chỉ khi đã ghi đè một file có sẵn. */
  mode: GoogleExportMode
  /** Muốn cập nhật nhưng file cũ đã bị xoá / vào thùng rác ⇒ đã tạo file mới. */
  recreated: boolean
  /** Thư mục chứa file; `null` khi file cũ nằm chỗ khác và Drive không cho chuyển. */
  folder: DriveFolder | null
}

export const googleDocModified = () =>
  new ApiError(
    409,
    "Google Doc này đã được sửa trong Google Docs sau lần xuất trước. Cập nhật sẽ ghi đè các thay đổi đó (vẫn khôi phục được trong Lịch sử phiên bản của Google Docs).",
    "GOOGLE_DOC_MODIFIED"
  )

interface LiveFile {
  version: string | null
  parents: string[]
}

/** File còn dùng được (tồn tại, chưa vào thùng rác) ⇒ version + thư mục cha. 404 / thùng rác ⇒ `null`; lỗi khác ném lên. */
const liveFile = async (drive: drive_v3.Drive, fileId: string): Promise<LiveFile | null> => {
  try {
    const { data } = await drive.files.get({ fileId, fields: "id,trashed,version,parents" })
    return data.trashed ? null : { version: data.version ?? null, parents: data.parents ?? [] }
  } catch (err) {
    if (googleErrorStatus(err) === 404) return null
    throw err
  }
}

/** `version` của Drive là số int64 dạng chuỗi. */
const isNewer = (current: string | null, exported: string | null): boolean => {
  if (!current || !exported) return false
  try {
    return BigInt(current) > BigInt(exported)
  } catch {
    return false
  }
}

const findAppFolder = async (drive: drive_v3.Drive, key: string, value: string): Promise<drive_v3.Schema$File | null> => {
  const { data } = await drive.files.list({
    q: `mimeType='${FOLDER_MIME}' and trashed=false and appProperties has { key='${key}' and value='${value}' }`,
    fields: "files(id,name)",
    pageSize: 1,
    spaces: "drive"
  })
  return data.files?.[0] ?? null
}

/** Tên thư mục dự án: tên dự án, bỏ ký tự điều khiển, tối đa 120 ký tự. */
const projectFolderName = (projectName: string): string => projectName.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 120) || "Dự án"

/**
 * Thư mục `FlintFlow / <Tên dự án>` của user, tạo nếu chưa có. Dự án đổi tên ⇒ đổi tên thư mục theo. `projectId` là
 * ObjectId (chỉ chữ + số) nên ghép thẳng vào truy vấn `appProperties` được.
 */
export const ensureProjectFolder = async (drive: drive_v3.Drive, projectId: string, projectName: string): Promise<DriveFolder> => {
  const root =
    (await findAppFolder(drive, ROOT_PROPERTY, "1")) ??
    (await drive.files.create({ requestBody: { name: ROOT_FOLDER_NAME, mimeType: FOLDER_MIME, appProperties: { [ROOT_PROPERTY]: "1" } }, fields: "id,name" })).data
  if (!root.id) throw new Error("Drive không trả id cho thư mục FlintFlow")

  const name = projectFolderName(projectName)
  let folder = await findAppFolder(drive, PROJECT_PROPERTY, projectId)
  if (!folder) {
    folder = (
      await drive.files.create({
        requestBody: { name, mimeType: FOLDER_MIME, parents: [root.id], appProperties: { [PROJECT_PROPERTY]: projectId } },
        fields: "id,name"
      })
    ).data
  } else if (folder.name !== name && folder.id) {
    await drive.files.update({ fileId: folder.id, requestBody: { name } })
  }
  if (!folder.id) throw new Error("Drive không trả id cho thư mục dự án")
  return { id: folder.id, path: `${root.name ?? ROOT_FOLDER_NAME} / ${name}`, url: folderUrl(folder.id) }
}

/**
 * Ghi đè file cũ; file chưa nằm trong thư mục dự án (bản xuất trước khi có thư mục) ⇒ chuyển vào luôn. Drive từ chối
 * chuyển ⇒ vẫn ghi nội dung, để file ở chỗ cũ.
 */
const overwrite = async (
  drive: drive_v3.Drive,
  fileId: string,
  live: LiveFile,
  folder: DriveFolder,
  title: string,
  media: () => { mimeType: string; body: Readable }
): Promise<drive_v3.Schema$File> => {
  const base = { fileId, requestBody: { name: title }, fields: FILE_FIELDS }
  if (live.parents.includes(folder.id)) return (await drive.files.update({ ...base, media: media() })).data
  try {
    return (await drive.files.update({ ...base, media: media(), addParents: folder.id, removeParents: live.parents.join(",") })).data
  } catch (err) {
    const status = googleErrorStatus(err)
    if (status !== 403 && status !== 400) throw err
    return (await drive.files.update({ ...base, media: media() })).data
  }
}

export const exportToGoogleDocs = async (input: GoogleExportInput): Promise<GoogleExportResult> => {
  const { auth, projectId, projectName, userId, docx, fileName, source, baselineId, lang, spineVersion, mode, force } = input
  const drive = createDrive({ version: "v3", auth })
  const title = fileName.replace(/\.docx$/i, "")
  const media = () => ({ mimeType: DOCX_MIME, body: Readable.from(docx) })

  // Doc liên kết (của khách) không bao giờ là đích ghi đè
  const previous =
    mode === "update"
      ? await GoogleDocLink.findOne({ projectId, userId, source, baselineId, lang, kind: { $ne: "linked" } }).sort({ exportedAt: -1 })
      : null

  let file: drive_v3.Schema$File
  let folder: DriveFolder
  let updated = false
  try {
    const live = previous ? await liveFile(drive, previous.fileId) : null
    if (previous && live && !force && isNewer(live.version, previous.driveVersion)) throw googleDocModified()
    folder = await ensureProjectFolder(drive, projectId, projectName)
    if (previous && live) {
      file = await overwrite(drive, previous.fileId, live, folder, title, media)
      updated = true
    } else {
      file = (
        await drive.files.create({ requestBody: { name: title, mimeType: GOOGLE_DOC_MIME, parents: [folder.id] }, media: media(), fields: FILE_FIELDS })
      ).data
    }
  } catch (err) {
    throw toGoogleApiError(err)
  }
  if (!file.id || !file.webViewLink) throw new Error("Drive không trả id / webViewLink cho file vừa xuất")

  const inFolder = (file.parents ?? [folder.id]).includes(folder.id)
  const fields = {
    fileId: file.id,
    title: file.name ?? title,
    webViewLink: file.webViewLink,
    exportedAt: new Date(),
    exportedSpineVersion: spineVersion,
    driveVersion: file.version ?? null,
    folderId: inFolder ? folder.id : null,
    folderPath: inFolder ? folder.path : null
  }
  if (previous) {
    // Cập nhật hoặc tạo lại thay file đã mất ⇒ vẫn là "file của nguồn này", không thêm link thứ hai
    await GoogleDocLink.updateOne({ _id: previous._id }, { $set: { ...fields, kind: "export" } })
  } else {
    await GoogleDocLink.create({ projectId, userId, kind: "export", source, baselineId, lang, ...fields })
  }

  return {
    fileId: fields.fileId,
    webViewLink: fields.webViewLink,
    title: fields.title,
    mode: updated ? "update" : "new",
    recreated: Boolean(previous) && !updated,
    folder: inFolder ? folder : null
  }
}
