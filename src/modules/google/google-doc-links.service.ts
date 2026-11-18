/**
 * google-doc-links.service.ts
 * ─────────────────────────────────────────────────────────────────
 * Google Doc thuộc một dự án: bản FlintFlow xuất ra (`export`) và Google Doc có sẵn được liên kết (`linked`).
 * Danh sách hiển thị cho mọi thành viên; trợ lý Google Docs chỉ nhận tài liệu nằm trong danh sách này.
 */
import { drive as createDrive } from "@googleapis/drive"
import type { OAuth2Client } from "google-auth-library"
import { GoogleDocLink, type GoogleDocKind, type GoogleDocSource, type IGoogleDocLink } from "./google-doc-link.model.js"
import { GOOGLE_DOC_MIME, folderUrl, type DriveFolder } from "./google-export.service.js"
import { toGoogleApiError } from "./google-api-error.js"
import { User } from "../user/user.model.js"
import * as spineRepository from "../spine/spine.repository.js"
import { ApiError } from "../../shared/utils/api-error.js"

const LIST_LIMIT = 100

export interface GoogleDocLinkView {
  fileId: string
  title: string
  webViewLink: string
  kind: GoogleDocKind
  source: GoogleDocSource | null
  lang: string | null
  baselineId: string | null
  /** Lần xuất / liên kết gần nhất. */
  exportedAt: Date
  owner: { id: string; name: string | null; email: string | null }
  /** Người đang xem là chủ file ⇒ cập nhật và dùng trợ lý được. */
  isMine: boolean
  folder: DriveFolder | null
  /** Bản nháp đã xuất nhưng dữ liệu dự án đổi sau đó. */
  stale: boolean
}

export const googleDocNotInProject = () =>
  new ApiError(
    404,
    "Google Doc này chưa thuộc dự án. Hãy xuất SRS sang Google Docs hoặc liên kết tài liệu vào dự án trước.",
    "GOOGLE_DOC_NOT_IN_PROJECT"
  )

const googleDocUnsupported = () =>
  new ApiError(
    400,
    "Chỉ liên kết được Google Tài liệu. File Word (.docx) cần mở bằng Google Tài liệu rồi chọn Tệp → Lưu dưới dạng Google Tài liệu.",
    "GOOGLE_DOC_UNSUPPORTED"
  )

const toView = (
  link: IGoogleDocLink,
  viewerId: string,
  owners: Map<string, { name: string | null; email: string | null }>,
  headVersion: number | null
): GoogleDocLinkView => {
  const ownerId = String(link.userId)
  const kind: GoogleDocKind = link.kind ?? "export"
  return {
    fileId: link.fileId,
    title: link.title,
    webViewLink: link.webViewLink,
    kind,
    source: link.source ?? null,
    lang: link.lang ?? null,
    baselineId: link.baselineId ?? null,
    exportedAt: link.exportedAt,
    owner: { id: ownerId, ...(owners.get(ownerId) ?? { name: null, email: null }) },
    isMine: ownerId === viewerId,
    folder: link.folderId && link.folderPath ? { id: link.folderId, path: link.folderPath, url: folderUrl(link.folderId) } : null,
    stale:
      kind === "export" &&
      link.source === "draft" &&
      typeof link.exportedSpineVersion === "number" &&
      headVersion !== null &&
      headVersion > link.exportedSpineVersion
  }
}

const loadOwners = async (links: IGoogleDocLink[]) => {
  const ids = [...new Set(links.map((l) => String(l.userId)))]
  const users = ids.length ? await User.find({ _id: { $in: ids } }).select("name email").lean() : []
  return new Map(users.map((u) => [String(u._id), { name: u.name ?? null, email: u.email ?? null }]))
}

/** Google Doc của dự án (mọi thành viên), mới nhất trước. */
export const listProjectLinks = async (projectId: string, viewerId: string): Promise<GoogleDocLinkView[]> => {
  const links = await GoogleDocLink.find({ projectId }).sort({ exportedAt: -1 }).limit(LIST_LIMIT)
  const [owners, head] = await Promise.all([loadOwners(links), spineRepository.versionHead(projectId)])
  return links.map((link) => toView(link, viewerId, owners, head?.spine_version ?? null))
}

/**
 * Liên kết một Google Doc chọn từ Picker vào dự án. Picker đã cấp quyền `drive.file` cho file ⇒ đọc được metadata bằng
 * token của user. Chỉ nhận Google Docs (trợ lý sửa qua Docs API). File đã thuộc dự án ⇒ trả lại bản đang có.
 */
export const linkProjectDoc = async (auth: OAuth2Client, projectId: string, userId: string, fileId: string): Promise<GoogleDocLinkView> => {
  let meta
  try {
    meta = (await createDrive({ version: "v3", auth }).files.get({ fileId, fields: "id,name,mimeType,trashed,webViewLink" })).data
  } catch (err) {
    throw toGoogleApiError(err)
  }
  if (meta.trashed) throw new ApiError(404, "Không tìm thấy file trên Google Drive (có thể đã bị xoá).", "GOOGLE_FILE_NOT_FOUND")
  if (meta.mimeType !== GOOGLE_DOC_MIME) throw googleDocUnsupported()

  const existing = await GoogleDocLink.findOne({ projectId, fileId }).sort({ exportedAt: -1 })
  const link =
    existing ??
    (await GoogleDocLink.create({
      projectId,
      userId,
      kind: "linked",
      fileId,
      title: meta.name ?? fileId,
      webViewLink: meta.webViewLink ?? `https://docs.google.com/document/d/${fileId}/edit`,
      exportedAt: new Date()
    }))
  const owners = await loadOwners([link])
  return toView(link, userId, owners, null)
}

/** Bỏ Google Doc khỏi dự án — chỉ xoá liên kết trong FlintFlow, file trên Drive giữ nguyên. */
export const unlinkProjectDoc = async (projectId: string, fileId: string): Promise<{ removed: number }> => {
  const { deletedCount } = await GoogleDocLink.deleteMany({ projectId, fileId })
  if (!deletedCount) throw googleDocNotInProject()
  return { removed: deletedCount }
}

export const isDocInProject = async (projectId: string, fileId: string): Promise<boolean> =>
  Boolean(await GoogleDocLink.exists({ projectId, fileId }))
