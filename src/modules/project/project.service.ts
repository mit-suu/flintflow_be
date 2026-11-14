import { erdNotationOf, type ErdNotation } from "../../shared/diagram/erd-notation.js"
import { sequenceLevelOf, type SequenceLevel } from "../../shared/diagram/sequence-level.js"
import { screenThemeOf, type ScreenTheme } from "../../shared/diagram/screen-theme.js"
import { Project, IProject, WITH_DELETED, type ProjectMode, type ProjectStartKind, type TemplateIntent } from "./project.model.js"
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
import { vietnameseSearchPattern } from "../../shared/utils/vi-search.js"
import type { ListProjectsQuery, ProjectListSort } from "./project.validation.js"
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

/** Lựa chọn lúc tạo dự án (FLF-335). Thiếu `source` ⇒ client cũ gửi `mode`. */
export interface ProjectStart {
  source?: ProjectStartKind
  has_required_template?: boolean
  /** Hộp Tạo dự án hai ô (business-flow §1): có file SRS không. Có trường này thì thắng `source` / `mode`. */
  has_srs_file?: boolean
  /** "Bổ sung các mục còn thiếu theo mẫu chuẩn FlintFlow" — chỉ có nghĩa khi có file SRS. */
  complete_to_standard?: boolean
}

export interface ResolvedProjectStart {
  mode: ProjectMode
  start_kind: ProjectStartKind
  has_required_template: boolean | null
  template_intent: TemplateIntent | null
}

/**
 * Business-flow §1 "Chọn chế độ" — hộp Tạo dự án hai ô (`has_srs_file`): người dùng chỉ khai có file SRS không và có tick
 * "Bổ sung các mục còn thiếu theo mẫu chuẩn FlintFlow" không:
 * - không SRS ⇒ `fpt` (chế độ 2);
 * - có SRS, không tick ⇒ `import` + `fixed` (cấu trúc đích = chính khung file; chế độ 1 / 3 quyết định sau khi đọc khung);
 * - có SRS, tick ⇒ `import` + `free` (cấu trúc đích = mẫu chuẩn FlintFlow; chế độ 1 / 4).
 * Mọi file tải lên là `existing` — file là khung trống hay SRS đã viết do màn đọc khung nhận ra từ nội dung.
 *
 * Client trước hộp hai ô (FLF-335) gửi `source` — Code suy ra từ hai lựa chọn:
 * - mới · không mẫu ⇒ `fpt` (chế độ 2, mẫu chuẩn FlintFlow);
 * - mới · có mẫu bắt buộc ⇒ `import` + `template_intent = fixed` (tải mẫu lên; chế độ 1 / 3 quyết định sau khi so cấu trúc đích);
 * - có sẵn ⇒ `import`, ý định (`fixed` / `free`) hỏi lúc upload (#2 `intent`); chế độ 1 / 3 / 4 quyết định sau.
 * Client cũ gửi `mode`: `customer_template` (từng trả 501) quy về mới · có mẫu bắt buộc; `import` ⇒ có sẵn; `fpt` ⇒ mới · không mẫu.
 */
export const resolveProjectStart = (mode: ProjectMode = "fpt", start: ProjectStart = {}): ResolvedProjectStart => {
  if (start.has_srs_file === false) return { mode: "fpt", start_kind: "new", has_required_template: false, template_intent: null }
  if (start.has_srs_file === true) {
    const intent: TemplateIntent = start.complete_to_standard === true ? "free" : "fixed"
    return { mode: "import", start_kind: "existing", has_required_template: null, template_intent: intent }
  }
  if (start.source === "new") {
    const required = start.has_required_template === true
    return { mode: required ? "import" : "fpt", start_kind: "new", has_required_template: required, template_intent: required ? "fixed" : null }
  }
  if (start.source === "existing") return { mode: "import", start_kind: "existing", has_required_template: null, template_intent: null }
  if (mode === "customer_template") return { mode: "import", start_kind: "new", has_required_template: true, template_intent: "fixed" }
  if (mode === "import") return { mode: "import", start_kind: "existing", has_required_template: null, template_intent: null }
  return { mode: "fpt", start_kind: "new", has_required_template: false, template_intent: null }
}

export const createProject = async (
  orgId: string,
  userId: string,
  name: string,
  domain?: string,
  mode: ProjectMode = "fpt",
  folderId?: string,
  documentLanguage?: UserLocale,
  start: ProjectStart = {}
): Promise<IProject> => {
  const resolved = resolveProjectStart(mode, start)
  // Tạo thẳng trong thư mục (một request) — thư mục phải thuộc cùng org
  if (folderId) await assertFolderOwned(orgId, folderId)
  await assertProjectQuota(orgId)
  // FLF-265 (D2, D3): dự án mới không mẫu lưu body ⇒ ngôn ngữ tài khoản ⇒ en. Dự án tải file lên bỏ qua giá trị gửi lên, để trống —
  // ngôn ngữ theo file upload
  const language = resolved.mode === "import" ? null : (documentLanguage ?? (await accountLocaleOf(userId)) ?? "en")
  // Mode 1 vẫn có Spine: ở đó Spine là chỉ mục trích từ tài liệu import (G2), không phải nguồn sự thật
  const project = await Project.create({
    organizationId: orgId,
    // userId giữ lại để biết ai tạo; quyền truy cập do organizationId quyết định (task-26 Pha 4).
    userId,
    name,
    domain: domain || null,
    status: "active",
    mode: resolved.mode,
    start_kind: resolved.start_kind,
    has_required_template: resolved.has_required_template,
    template_intent: resolved.template_intent,
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

const PROJECT_LIST_ORDER: Record<ProjectListSort, Record<string, 1 | -1>> = {
  created: { createdAt: -1, _id: -1 },
  updated: { updatedAt: -1, _id: -1 },
  // Mongo xếp null nhỏ nhất ⇒ giảm dần thì dự án chưa mở nằm cuối (khớp vùng "Chưa mở" của FE)
  opened: { lastOpenedAt: -1, _id: -1 }
}

/**
 * Một trang dự án của org (FLF-404): lọc trạng thái / cách làm / thư mục, tìm tên không dấu, sắp xếp — tất cả ở BE, vì lọc
 * trên mấy trang đã tải ở FE sẽ ra kết quả sai. Document trả nguyên như `getProjects` (cùng hình JSON).
 */
export const listProjectsPage = async (orgId: string, query: ListProjectsQuery) => {
  const { page, limit, status, mode, q, sort, folder } = query
  const filter: Record<string, unknown> = { organizationId: orgId }
  if (status) filter.status = status
  if (mode) filter.mode = mode
  if (q) filter.name = vietnameseSearchPattern(q)
  if (folder) filter.folderId = folder === "none" ? null : new mongoose.Types.ObjectId(folder)

  const [total, items] = await Promise.all([
    Project.countDocuments(filter),
    Project.find(filter)
      .sort(PROJECT_LIST_ORDER[sort])
      .skip((page - 1) * limit)
      .limit(limit)
  ])
  return { items, meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } }
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

/**
 * `hard` = nút "Xoá vĩnh viễn" của FE. FLF-401: BE chỉ xoá mềm — đặt `deletedAt` / `deletedBy`, KHÔNG dọn dữ liệu (chat,
 * tài liệu, Spine, file còn nguyên để khôi phục bằng tay); dự án biến khỏi mọi truy vấn nhờ middleware của `Project`.
 * Response giữ hình dạng cũ `{ _id, status: "deleted" }`. Không `hard` = Lưu trữ (`status: "archived"`) như cũ.
 */
export const deleteProject = async (
  projectId: string,
  orgId: string,
  hard: boolean = false,
  deletedBy: string | null = null
): Promise<IProject | { _id: string; status: "deleted" }> => {
  if (hard) {
    const project = mongoose.isValidObjectId(projectId)
      ? await Project.findOneAndUpdate(
          { _id: projectId, organizationId: orgId },
          { $set: { deletedAt: new Date(), deletedBy: deletedBy && mongoose.isValidObjectId(deletedBy) ? deletedBy : null } },
          { new: true }
        )
      : null
    if (!project) {
      throw new ApiError(404, "Không tìm thấy dự án hoặc bạn không có quyền truy cập.", "PROJECT_NOT_FOUND")
    }
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

/**
 * FLF-401: xoá cứng + dọn toàn bộ dữ liệu — chỉ dùng khi xoá cả tổ chức (dự án đã xoá mềm cũng dọn). Không có trên API.
 * Trả `false` khi không có dự án.
 */
export const purgeProject = async (projectId: string, orgId: string): Promise<boolean> => {
  const project = await Project.findOneAndDelete({ _id: projectId, organizationId: orgId }).setOptions(WITH_DELETED)
  if (!project) return false
  await purgeProjectData(projectId)
  return true
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
 * thiếu `mode` (= fpt) vẫn khớp `$ne`. FLF-318: dự án tạo SRS đã chuyển sang mode 1 (`converted_from = fpt`) KHÔNG phải
 * dự án tải file lên ⇒ vẫn đổi được (business-flow nguyên tắc 7); `TemplateProfile.language` của nó đổi theo.
 */
export const setDocumentLanguage = async (
  projectId: string,
  orgId: string,
  documentLanguage: UserLocale
): Promise<IProject> => {
  const notFound = () => new ApiError(404, "Không tìm thấy dự án hoặc bạn không có quyền truy cập.", "PROJECT_NOT_FOUND")
  if (!mongoose.isValidObjectId(projectId)) throw notFound()
  const project = await Project.findOneAndUpdate(
    { _id: projectId, organizationId: orgId, $or: [{ mode: { $ne: "import" } }, { converted_from: "fpt" }] },
    { documentLanguage },
    { new: true }
  )
  if (project?.converted_from === "fpt") await TemplateProfile.updateOne({ projectId }, { $set: { language: documentLanguage } })
  if (project) return project
  // Không khớp: phân biệt dự án mode 1 (409) với dự án không có / thuộc org khác (404)
  const existing = await Project.findOne({ _id: projectId, organizationId: orgId }).select("mode").lean()
  if (!existing) throw notFound()
  throw new Mode1Error(DOCUMENT_LANGUAGE_LOCKED, "Dự án tải tài liệu lên dùng ngôn ngữ của file, không đổi được.")
}

/**
 * Đổi ký pháp ERD (§3.1.5). Chỉ ghi field của Project — Spine không đổi. Ký pháp là một phần của hash hình ERD
 * (`renderedDiagramHash`), nên đổi xong ERD đã vẽ thành `diagram_stale`; ở đây vẽ lại ngay (renderer SVG không cần PlantUML)
 * để người dùng thấy hình mới mà không phải bấm "Vẽ lại". Vẽ lại lỗi chỉ ghi log: lựa chọn ký pháp đã lưu, hình stale
 * vẫn được vẽ lại ở lượt render kế tiếp.
 */
export const setErdNotation = async (projectId: string, orgId: string, erdNotation: ErdNotation, userId: string): Promise<IProject> => {
  const notFound = () => new ApiError(404, "Không tìm thấy dự án hoặc bạn không có quyền truy cập.", "PROJECT_NOT_FOUND")
  if (!mongoose.isValidObjectId(projectId)) throw notFound()
  const before = await Project.findOne({ _id: projectId, organizationId: orgId }).select("erdNotation").lean()
  if (!before) throw notFound()
  const project = await Project.findOneAndUpdate({ _id: projectId, organizationId: orgId }, { erdNotation }, { new: true })
  if (!project) throw notFound()
  if (erdNotationOf(before) !== erdNotation) await redrawErd(projectId, userId)
  return project
}

/**
 * Đổi mức Sequence Diagram (FLF-418), cùng cách làm với `setErdNotation`: chỉ ghi field của Project, Spine không đổi. Mức là
 * một phần của hash hình `sequence` (`renderedExtras`) ⇒ đổi xong sơ đồ đã vẽ thành `diagram_stale`; vẽ lại ngay (cần
 * PlantUML server). Vẽ lại lỗi chỉ ghi log: lựa chọn đã lưu, hình stale được vẽ lại ở lượt render kế tiếp.
 */
export const setSequenceLevel = async (projectId: string, orgId: string, sequenceLevel: SequenceLevel, userId: string): Promise<IProject> => {
  const notFound = () => new ApiError(404, "Không tìm thấy dự án hoặc bạn không có quyền truy cập.", "PROJECT_NOT_FOUND")
  if (!mongoose.isValidObjectId(projectId)) throw notFound()
  const before = await Project.findOne({ _id: projectId, organizationId: orgId }).select("sequenceLevel").lean()
  if (!before) throw notFound()
  const project = await Project.findOneAndUpdate({ _id: projectId, organizationId: orgId }, { sequenceLevel }, { new: true })
  if (!project) throw notFound()
  if (sequenceLevelOf(before) !== sequenceLevel) await redrawSequences(projectId, userId)
  return project
}

/**
 * Đổi theme mockup màn (FLF-410). Chỉ ghi field của Project — Spine không đổi. Theme đã resolve nằm trong hash hình
 * `screen_layout` ⇒ đổi xong mọi mockup đã vẽ thành stale; vẽ lại ngay bằng spec đã lưu trong SVG (0 lượt model, 0 credit).
 * Màn chưa có spec (bảng function, wireframe cũ) giữ nguyên đến lượt vẽ kế tiếp. Vẽ lại lỗi chỉ ghi log.
 */
export const setScreenTheme = async (projectId: string, orgId: string, patch: Partial<ScreenTheme>, userId: string): Promise<IProject> => {
  const notFound = () => new ApiError(404, "Không tìm thấy dự án hoặc bạn không có quyền truy cập.", "PROJECT_NOT_FOUND")
  if (!mongoose.isValidObjectId(projectId)) throw notFound()
  const before = await Project.findOne({ _id: projectId, organizationId: orgId }).select("screenTheme").lean()
  if (!before) throw notFound()
  const next: ScreenTheme = { ...screenThemeOf(before), ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) }
  const project = await Project.findOneAndUpdate({ _id: projectId, organizationId: orgId }, { $set: { screenTheme: next } }, { new: true })
  if (!project) throw notFound()
  if (JSON.stringify(screenThemeOf(before)) !== JSON.stringify(screenThemeOf(project))) await redrawScreenLayouts(projectId, userId)
  return project
}

/** Vẽ lại mockup đã có bằng spec đã lưu — không gọi model. Lỗi chỉ ghi log. */
export const redrawScreenLayouts = async (projectId: string, userId: string): Promise<void> => {
  try {
    const spine = await spineRepository.get(projectId)
    if (!spine?.diagrams.some((d) => d.kind === "screen_layout")) return
    const { redrawScreenLayoutsFromSpec } = await import("../diagram/diagram.service.js")
    await redrawScreenLayoutsFromSpec(projectId, { by: userId, step_id: null })
  } catch (err) {
    console.warn(`[project] vẽ lại mockup màn sau khi đổi theme lỗi (project ${projectId}): ${err instanceof Error ? err.message : String(err)}`)
  }
}

const redrawSequences = async (projectId: string, userId: string): Promise<void> => {
  try {
    const spine = await spineRepository.get(projectId)
    if (!spine?.diagrams.some((d) => d.kind === "sequence")) return
    const { renderDiagram } = await import("../diagram/diagram.service.js")
    await renderDiagram(projectId, "sequence", null, { by: userId, step_id: null })
  } catch (err) {
    console.warn(`[project] vẽ lại Sequence Diagram sau khi đổi mức lỗi (project ${projectId}): ${err instanceof Error ? err.message : String(err)}`)
  }
}

const redrawErd = async (projectId: string, userId: string): Promise<void> => {
  try {
    const spine = await spineRepository.get(projectId)
    if (!spine?.diagrams.some((d) => d.kind === "erd")) return
    const { renderDiagram } = await import("../diagram/diagram.service.js")
    await renderDiagram(projectId, "erd", null, { by: userId, step_id: null })
  } catch (err) {
    console.warn(`[project] vẽ lại ERD sau khi đổi ký pháp lỗi (project ${projectId}): ${err instanceof Error ? err.message : String(err)}`)
  }
}
