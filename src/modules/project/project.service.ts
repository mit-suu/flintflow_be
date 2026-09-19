import { Project, IProject, type ProjectMode } from "./project.model.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { ChatSession } from "./chat-session.model.js"
import { ProjectDocument } from "./project-document.model.js"
import { destroyDocumentAsset } from "./project-document.storage.js"
import * as spineRepository from "../spine/spine.repository.js"
import { Spine } from "../spine/spine.model.js"
import { Change } from "../spine/change.model.js"
import { Baseline } from "../spine/baseline.model.js"
import { Usage } from "../spine/usage.model.js"
import { RenderedDocumentCache } from "../render/rendered-document.model.js"
import { gridFsDiagramStore } from "../diagram/diagram-file.store.js"
import mongoose from "mongoose"
import { assertFolderOwned, folderStillExists } from "../folder/folder.service.js"
import { ImportedDocument } from "../import/imported-document.model.js"
import { DocBlock } from "../import/doc-block.model.js"
import { TemplateProfile } from "../import/template-profile.model.js"
import { ExtractionDraft } from "../import/extraction-draft.model.js"
import { FieldAnchor } from "../import/field-anchor.model.js"
import { ReuploadDiff } from "../import/reupload-diff.model.js"
import { DocVersion } from "../doc-version/doc-version.model.js"
import { docFileStore } from "../doc-version/doc-file.store.js"
import { ChangeRequest, CrCounter } from "../change-request/change-request.model.js"
import { ChangeLocation } from "../change-request/change-location.model.js"
import { ChangeGroup } from "../change-request/change-group.model.js"

export const createProject = async (
  userId: string,
  name: string,
  domain?: string,
  mode: ProjectMode = "fpt",
  folderId?: string
): Promise<IProject> => {
  if (mode === "customer_template") {
    throw new ApiError(501, "Mode template khách hàng chưa hỗ trợ", "NOT_IMPLEMENTED")
  }
  // Tạo thẳng trong thư mục (một request) — thư mục phải của chính user
  if (folderId) await assertFolderOwned(userId, folderId)
  // Mode 1 vẫn có Spine: ở đó Spine là chỉ mục trích từ tài liệu import (G2), không phải nguồn sự thật
  const project = await Project.create({
    userId,
    name,
    domain: domain || null,
    status: "active",
    mode,
    ...(folderId ? { folderId } : {})
  })
  await spineRepository.getOrCreate(project.id, { name, domain: domain || null })
  return project
}

export const getProjects = async (userId: string, status?: string): Promise<IProject[]> => {
  const filter: any = { userId }
  if (status) {
    filter.status = status
  }
  return await Project.find(filter).sort({ createdAt: -1 })
}

export const getProjectById = async (
  projectId: string,
  userId: string
): Promise<IProject> => {
  const project = await Project.findOne({ _id: projectId, userId })
  if (!project) {
    throw new ApiError(404, "Project not found or unauthorized", "PROJECT_NOT_FOUND")
  }
  return project
}

/**
 * Mở dự án (`GET /projects/:id` — workspace, bản đọc): ghi `lastOpenedAt`. `timestamps: false` ⇒ không đẩy
 * `updatedAt` (mở không phải là sửa). Chỉ route này ghi; các nơi nội bộ vẫn dùng `getProjectById`.
 */
export const openProject = async (projectId: string, userId: string): Promise<IProject> => {
  const notFound = () => new ApiError(404, "Project not found or unauthorized", "PROJECT_NOT_FOUND")
  if (!mongoose.isValidObjectId(projectId)) throw notFound()
  const project = await Project.findOneAndUpdate(
    { _id: projectId, userId },
    { $set: { lastOpenedAt: new Date() } },
    { new: true, timestamps: false }
  )
  if (!project) throw notFound()
  return project
}

/**
 * Dọn mọi dữ liệu thuộc project khi xoá cứng: Spine và các collection tách riêng của nó (changes,
 * baselines chứa snapshot lớn, usages), bản render đã cache, file sơ đồ trong GridFS, tài liệu upload
 * cùng file gốc trên Cloudinary.
 *
 * Notification và PaymentIntent KHÔNG xoá: chúng thuộc user (không có `projectId`) — lịch sử thanh toán
 * và credit không được mất theo project.
 */
const purgeProjectData = async (projectId: string): Promise<void> => {
  const [spine, documents] = await Promise.all([
    spineRepository.get(projectId),
    ProjectDocument.find({ projectId }).select("cloudinaryPublicId").lean()
  ])

  await Promise.all([
    ChatSession.deleteMany({ projectId }),
    ProjectDocument.deleteMany({ projectId }),
    Spine.deleteMany({ projectId }),
    Change.deleteMany({ projectId }),
    Baseline.deleteMany({ projectId }),
    Usage.deleteMany({ projectId }),
    RenderedDocumentCache.deleteMany({ projectId }),
    // Mode 1 (FLF-171): import, block, version, change request
    ImportedDocument.deleteMany({ projectId }),
    DocBlock.deleteMany({ projectId }),
    TemplateProfile.deleteMany({ projectId }),
    ExtractionDraft.deleteMany({ projectId }),
    FieldAnchor.deleteMany({ projectId }),
    ReuploadDiff.deleteMany({ projectId }),
    DocVersion.deleteMany({ projectId }),
    ChangeRequest.deleteMany({ projectId }),
    CrCounter.deleteMany({ projectId }),
    ChangeLocation.deleteMany({ projectId }),
    ChangeGroup.deleteMany({ projectId })
  ])

  // File ngoài collection: lỗi ở đây không được làm hỏng việc xoá đã xong ở trên
  for (const diagram of spine?.diagrams ?? []) {
    await gridFsDiagramStore.remove(projectId, diagram.id).catch((err: unknown) => {
      console.warn(`[Project] Không xoá được file sơ đồ ${diagram.id} của project ${projectId}:`, err)
    })
  }
  for (const doc of documents) await destroyDocumentAsset(doc.cloudinaryPublicId)
  await docFileStore()
    .removeProject(projectId)
    .catch((err: unknown) => console.warn(`[Project] Không xoá được file .docx mode 1 của project ${projectId}:`, err))
}

export const deleteProject = async (
  projectId: string,
  userId: string,
  hard: boolean = false
): Promise<IProject | { _id: string; status: "deleted" }> => {
  if (hard) {
    const project = await Project.findOneAndDelete({ _id: projectId, userId })
    if (!project) {
      throw new ApiError(404, "Project not found or unauthorized", "PROJECT_NOT_FOUND")
    }
    await purgeProjectData(projectId)
    return { _id: projectId, status: "deleted" }
  }

  const project = await Project.findOneAndUpdate(
    { _id: projectId, userId },
    { status: "archived" },
    { new: true }
  )
  if (!project) {
    throw new ApiError(404, "Project not found or unauthorized", "PROJECT_NOT_FOUND")
  }
  return project
}

export const updateProjectName = async (
  projectId: string,
  userId: string,
  name: string
): Promise<IProject> => {
  const project = await Project.findOneAndUpdate(
    { _id: projectId, userId },
    { name },
    { new: true }
  )
  if (!project) {
    throw new ApiError(404, "Project not found or unauthorized", "PROJECT_NOT_FOUND")
  }
  return project
}

/** Chuyển dự án vào thư mục của chính user (`folderId: null` ⇒ ra ngoài thư mục). */
export const moveProjectToFolder = async (
  projectId: string,
  userId: string,
  folderId: string | null
): Promise<IProject> => {
  const notFound = () => new ApiError(404, "Project not found or unauthorized", "PROJECT_NOT_FOUND")
  // id sai định dạng ⇒ 404 như dự án của user khác (không để CastError thành 500)
  if (!mongoose.isValidObjectId(projectId)) throw notFound()
  if (folderId) await assertFolderOwned(userId, folderId)
  const project = await Project.findOneAndUpdate({ _id: projectId, userId }, { folderId }, { new: true })
  if (!project) throw notFound()
  // Thư mục bị xoá chen giữa lúc kiểm tra và lúc ghi ⇒ gỡ về ngoài thư mục, báo thư mục không còn
  if (folderId && !(await folderStillExists(userId, folderId))) {
    await Project.updateOne({ _id: projectId, userId, folderId }, { folderId: null })
    throw new ApiError(404, "Folder not found or unauthorized", "FOLDER_NOT_FOUND")
  }
  return project
}
