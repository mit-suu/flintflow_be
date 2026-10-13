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
import { SpineTranslation } from "../translation/spine-translation.model.js"
import { TranslationGlossary } from "../translation/translation-glossary.model.js"
import { TranslationRunLock } from "../translation/translation-run-lock.model.js"
import { Subscription } from "../credits/subscription.model.js"
import { getPlan } from "../billing/plan.config.js"
import { accountLocaleOf } from "../user/account-locale.js"
import type { UserLocale } from "../../shared/i18n/locale.js"
import { Mode1Error, type Mode1ErrorCode } from "../import/mode1.errors.js"

/** FLF-265: dự án mode 1 đọc ngôn ngữ theo file upload (D3) — không đổi bằng tay. Mã đăng ký ở `MODE1_ERROR_STATUS`. */
export const DOCUMENT_LANGUAGE_LOCKED = "DOCUMENT_LANGUAGE_LOCKED" satisfies Mode1ErrorCode

/**
 * UC-16: số dự án tối đa theo gói đang active của tổ chức (`plan.config` — free 3, pro 50). Dự án đã xoá
 * (`archived`) không tính. Kiểm trước khi tạo, không khoá — hai request cùng lúc có thể vượt 1, chấp nhận được.
 */
export const assertProjectQuota = async (orgId: string): Promise<void> => {
  const [subscription, count] = await Promise.all([
    Subscription.findOne({ organizationId: orgId, status: "active" }).select("plan").lean(),
    Project.countDocuments({ organizationId: orgId, status: { $ne: "archived" } })
  ])
  const definition = getPlan(subscription?.plan ?? "free")
  if (count >= definition.maxProjects) {
    throw new ApiError(402, `Gói ${definition.label} chỉ cho tối đa ${definition.maxProjects} dự án`, "PLAN_LIMIT_PROJECTS")
  }
}

export const createProject = async (
  orgId: string,
  userId: string,
  name: string,
  domain?: string,
  mode: ProjectMode = "fpt",
  folderId?: string,
  documentLanguage?: UserLocale
): Promise<IProject> => {
  if (mode === "customer_template") {
    throw new ApiError(501, "Chưa hỗ trợ tạo dự án theo mẫu của khách hàng.", "NOT_IMPLEMENTED")
  }
  // Tạo thẳng trong thư mục (một request) — thư mục phải thuộc cùng org
  if (folderId) await assertFolderOwned(orgId, folderId)
  await assertProjectQuota(orgId)
  // FLF-265 (D2, D3): mode 2 lưu body ⇒ ngôn ngữ tài khoản ⇒ en. Mode 1 bỏ qua giá trị gửi lên, để trống — ngôn ngữ theo file upload
  const language = mode === "import" ? null : (documentLanguage ?? (await accountLocaleOf(userId)) ?? "en")
  // Mode 1 vẫn có Spine: ở đó Spine là chỉ mục trích từ tài liệu import (G2), không phải nguồn sự thật
  const project = await Project.create({
    organizationId: orgId,
    // userId giữ lại để biết ai tạo; quyền truy cập do organizationId quyết định (task-26 Pha 4).
    userId,
    name,
    domain: domain || null,
    status: "active",
    mode,
    ...(language ? { documentLanguage: language } : {}),
    ...(folderId ? { folderId } : {})
  })
  await spineRepository.getOrCreate(project.id, { name, domain: domain || null })
  return project
}

export const getProjects = async (orgId: string, status?: string): Promise<IProject[]> => {
  const filter: any = { organizationId: orgId }
  if (status) {
    filter.status = status
  }
  return await Project.find(filter).sort({ createdAt: -1 })
}

/**
 * Điểm chốt quyền truy cập dự án cho CẢ HỆ THỐNG — 10 module gọi hàm này (spine, pipeline, render,
 * diagram, import, change-request…). Lọc theo org chứ không theo người: dự án thuộc về tổ chức, mọi
 * thành viên đều vào được, và vai trò quyết định làm được gì (BPMN Flow 10.6–10.7).
 */
export const getProjectById = async (
  projectId: string,
  orgId: string
): Promise<IProject> => {
  // Id sai định dạng: CastError sẽ thành 500 — coi như không tìm thấy (FLF-244)
  const project = mongoose.isValidObjectId(projectId) ? await Project.findOne({ _id: projectId, organizationId: orgId }) : null
  if (!project) {
    throw new ApiError(404, "Không tìm thấy dự án hoặc bạn không có quyền truy cập.", "PROJECT_NOT_FOUND")
  }
  return project
}

/**
 * Mở dự án (`GET /projects/:id` — workspace, bản đọc): ghi `lastOpenedAt`. `timestamps: false` ⇒ không đẩy
 * `updatedAt` (mở không phải là sửa). Chỉ route này ghi; các nơi nội bộ vẫn dùng `getProjectById`.
 */
export const openProject = async (projectId: string, orgId: string): Promise<IProject> => {
  const notFound = () => new ApiError(404, "Không tìm thấy dự án hoặc bạn không có quyền truy cập.", "PROJECT_NOT_FOUND")
  if (!mongoose.isValidObjectId(projectId)) throw notFound()
  const project = await Project.findOneAndUpdate(
    { _id: projectId, organizationId: orgId },
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
    ChangeGroup.deleteMany({ projectId }),
    // FLF-265: lớp bản dịch + glossary dịch + khoá lượt dịch
    SpineTranslation.deleteMany({ projectId }),
    TranslationGlossary.deleteMany({ projectId }),
    TranslationRunLock.deleteMany({ projectId })
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
  orgId: string,
  hard: boolean = false
): Promise<IProject | { _id: string; status: "deleted" }> => {
  if (hard) {
    const project = await Project.findOneAndDelete({ _id: projectId, organizationId: orgId })
    if (!project) {
      throw new ApiError(404, "Không tìm thấy dự án hoặc bạn không có quyền truy cập.", "PROJECT_NOT_FOUND")
    }
    await purgeProjectData(projectId)
    return { _id: projectId, status: "deleted" }
  }

  const project = await Project.findOneAndUpdate(
    { _id: projectId, organizationId: orgId },
    { status: "archived" },
    { new: true }
  )
  if (!project) {
    throw new ApiError(404, "Không tìm thấy dự án hoặc bạn không có quyền truy cập.", "PROJECT_NOT_FOUND")
  }
  return project
}

export const updateProjectName = async (
  projectId: string,
  orgId: string,
  name: string
): Promise<IProject> => {
  const project = await Project.findOneAndUpdate(
    { _id: projectId, organizationId: orgId },
    { name },
    { new: true }
  )
  if (!project) {
    throw new ApiError(404, "Không tìm thấy dự án hoặc bạn không có quyền truy cập.", "PROJECT_NOT_FOUND")
  }
  return project
}

/** Chuyển dự án vào thư mục của chính user (`folderId: null` ⇒ ra ngoài thư mục). */
export const moveProjectToFolder = async (
  projectId: string,
  orgId: string,
  folderId: string | null
): Promise<IProject> => {
  const notFound = () => new ApiError(404, "Không tìm thấy dự án hoặc bạn không có quyền truy cập.", "PROJECT_NOT_FOUND")
  // id sai định dạng ⇒ 404 như dự án của user khác (không để CastError thành 500)
  if (!mongoose.isValidObjectId(projectId)) throw notFound()
  if (folderId) await assertFolderOwned(orgId, folderId)
  const project = await Project.findOneAndUpdate({ _id: projectId, organizationId: orgId }, { folderId }, { new: true })
  if (!project) throw notFound()
  // Thư mục bị xoá chen giữa lúc kiểm tra và lúc ghi ⇒ gỡ về ngoài thư mục, báo thư mục không còn
  if (folderId && !(await folderStillExists(orgId, folderId))) {
    await Project.updateOne({ _id: projectId, organizationId: orgId, folderId }, { folderId: null })
    throw new ApiError(404, "Không tìm thấy thư mục hoặc bạn không có quyền truy cập.", "FOLDER_NOT_FOUND")
  }
  return project
}

/**
 * Đổi ngôn ngữ tài liệu (FLF-265, D2). Chỉ ghi field — không đụng Spine, không xoá cache render (phase 3 đưa ngôn
 * ngữ vào đường render). Mode 1 ⇒ 409 `DOCUMENT_LANGUAGE_LOCKED` (D3). Lọc `mode` ngay trong lệnh ghi: dự án cũ
 * thiếu `mode` (= fpt) vẫn khớp `$ne`.
 */
export const setDocumentLanguage = async (
  projectId: string,
  orgId: string,
  documentLanguage: UserLocale
): Promise<IProject> => {
  const notFound = () => new ApiError(404, "Không tìm thấy dự án hoặc bạn không có quyền truy cập.", "PROJECT_NOT_FOUND")
  if (!mongoose.isValidObjectId(projectId)) throw notFound()
  const project = await Project.findOneAndUpdate(
    { _id: projectId, organizationId: orgId, mode: { $ne: "import" } },
    { documentLanguage },
    { new: true }
  )
  if (project) return project
  // Không khớp: phân biệt dự án mode 1 (409) với dự án không có / thuộc org khác (404)
  const existing = await Project.findOne({ _id: projectId, organizationId: orgId }).select("mode").lean()
  if (!existing) throw notFound()
  throw new Mode1Error(DOCUMENT_LANGUAGE_LOCKED, "Dự án tải tài liệu lên dùng ngôn ngữ của file, không đổi được.")
}
