/**
 * render.controller.ts
 * ─────────────────────────────────────────────────────────────────
 * POST /projects/:projectId/assemble               S-8.2 ghép RenderedDocument, cache
 * GET  /projects/:projectId/document?source=&baseline_id=   trả RenderedDocument (ảnh dạng tham chiếu `image-ref:`)
 * GET  /projects/:projectId/document/image?ref=             bytes một ảnh của tài liệu theo tham chiếu (FLF-369)
 * GET  /projects/:projectId/version                         spine_version + revision tài liệu (FLF-369)
 *
 * `GET /projects/:projectId/export/word` nằm ở `export.controller.ts` (T05 tạo file, T15 thêm route
 * thật — dùng chung `getDocument` ở đây qua `assemble.service.ts`).
 * Hợp đồng: docs/api/pipeline-contract.md endpoint 16, 17.
 */

import { Request, Response } from "express"
import mongoose from "mongoose"
import { z } from "zod"
import { getProjectById } from "../project/project.service.js"
import { requireOrgId } from "../../shared/auth/org-request.js"
import { assembleRequestSchema, assembleResponseSchema, documentQuerySchema, documentTranslationMetaSchema } from "../pipeline/pipeline.dto.js"
import { assemble, getDocumentWithMeta, getDraftMeta, NoWorkingDraftError } from "./assemble.service.js"
import { projectLanguages } from "../translation/translation.service.js"
import type { UserLocale } from "../../shared/i18n/locale.js"
import type { TemplateIntent } from "../project/project.model.js"
import { sendError, sendSuccess } from "../../shared/types/api-response.js"
import { catchAsync } from "../../shared/utils/catch-async.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { validationError } from "../../shared/utils/validation-message.js"
import { isViewer } from "../../shared/auth/viewer-read-scope.middleware.js"
import { viewerDocument } from "./viewer-projection.js"
import * as spineRepository from "../spine/spine.repository.js"
import { DIAGRAM_FILE_CSP } from "../diagram/diagram.controller.js"
import { parseImageRef, readImageRef, refDiagramPngLoader, refLocalizedPngLoader } from "./image-ref.js"
import { documentVersion } from "./document-revision.js"

const parse = <T extends z.ZodType>(schema: T, input: unknown): z.infer<T> => {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw validationError(parsed.error)
  return parsed.data
}

interface Context {
  projectId: string
  projectName: string
  /** `import` = mode 1 (tài liệu nhập) — phụ lục cờ của file Word in tiếng Việt. */
  mode?: string
  /** FLF-265 §3.1 — ngôn ngữ tài liệu (xem trước + .docx) theo `Project.documentLanguage`, không theo mode / query. */
  documentLanguage: UserLocale
  /** Ngôn ngữ chữ trong Spine (mode 2 = `en`). Khác `documentLanguage` ⇒ tài liệu dựng từ lớp bản dịch. */
  sourceLanguage: UserLocale
  /** FLF-318: `fpt` = dự án tạo SRS đã chuyển sang mode 1 — file Word theo mẫu FPT như mode 2. */
  convertedFrom: string | null
  templateIntent: TemplateIntent | null
}

/** Kiểm quyền sở hữu project trước khi đọc body/query — người ngoài không dò được DTO qua lỗi 400. */
export const authorize = async (req: Request): Promise<Context> => {
  const userId = req.user?.userId
  if (!userId) throw new ApiError(401, "Bạn chưa đăng nhập hoặc phiên đăng nhập đã hết hạn.", "UNAUTHORIZED")

  const projectId = req.params.projectId as string
  if (!mongoose.isValidObjectId(projectId)) throw new ApiError(404, "Không tìm thấy dự án hoặc bạn không có quyền truy cập.", "PROJECT_NOT_FOUND")
  const project = await getProjectById(projectId, requireOrgId(req))
  // FLF-265: mode 2 không truy vấn thêm; mode 1 đọc `TemplateProfile.language` (cả hai cùng ngôn ngữ file)
  const { locale, source } = await projectLanguages(projectId, project)
  return {
    projectId,
    projectName: project.name,
    mode: (project as { mode?: string }).mode,
    documentLanguage: locale,
    sourceLanguage: source,
    convertedFrom: project.converted_from ?? null,
    templateIntent: project.template_intent ?? null
  }
}

// ─── POST /assemble ──────────────────────────────────────────────

export const assembleController = catchAsync(async (req: Request, res: Response) => {
  const { projectId, projectName } = await authorize(req)
  const body = parse(assembleRequestSchema, req.body)
  const result = await assemble(projectId, projectName, body.base_version)
  // review Th2: findings S-8.4 đi qua meta thay vì console.warn toàn bộ — data vẫn đúng khuôn
  // assembleResponseSchema (field `findings` không thuộc contract, bị parse() lọc bỏ khỏi data).
  return sendSuccess(res, 200, assembleResponseSchema.parse(result), { consistency: result.findings })
})

// ─── GET /document ───────────────────────────────────────────────

export const getDocumentController = catchAsync(async (req: Request, res: Response) => {
  const { projectId, projectName, documentLanguage, sourceLanguage } = await authorize(req)
  const query = parse(documentQuerySchema, req.query)
  // FLF-369: revision đọc TRƯỚC khi dựng ⇒ thay đổi chen giữa làm revision cũ hơn tài liệu thực tế, client tải lại thêm
  // một lần (an toàn), không bao giờ ngược lại
  const version = query.source === "draft" ? await documentVersion(projectId, { locale: documentLanguage, source: sourceLanguage }) : null

  try {
    // FLF-265: ngôn ngữ lấy từ project — xem trước không nhận `?lang=` (chỉ tải file #18/#34, FLF-334 B)
    // FLF-369: ảnh dạng tham chiếu — FE tải riêng qua /document/image; export Word/PDF và comment vẫn nhúng PNG
    const result = await getDocumentWithMeta(
      projectId,
      projectName,
      // Chỉ xem trước mới dùng lại bản dịch đã dựng (ảnh tham chiếu) — export / comment luôn dựng mới
      { ...query, languages: { locale: documentLanguage, source: sourceLanguage }, reuseTranslated: true },
      { loadDiagramPng: refDiagramPngLoader(), loadLocalizedDiagramPng: refLocalizedPngLoader() }
    )
    // review C2: source=draft trước đây trả im lặng bản cache mới nhất dù Spine đã đổi tiếp — đính
    // kèm độ mới để caller (FE) tự quyết định có báo "tài liệu đang xem đã cũ" hay không.
    // FLF-265: bản dịch dựng mới mỗi lần, không ghi cache ⇒ độ mới lấy từ chính bản vừa dựng.
    const draftMeta = query.source === "draft" ? (result.draftMeta ?? (await getDraftMeta(projectId))) : null
    const meta = {
      ...(draftMeta
        ? { assembled_at_version: draftMeta.assembled_at_version, spine_version: draftMeta.spine_version, stale: draftMeta.stale }
        : {}),
      ...(version ? { document_revision: version.document_revision } : {}),
      // Chỉ khi ngôn ngữ tài liệu ≠ ngôn ngữ gốc (contract #16) — draft lẫn baseline
      ...(result.translation ? { translation: documentTranslationMetaSchema.parse(result.translation) } : {})
    }
    // UC-47: Viewer nhận bản không cờ / trạng thái nội bộ
    const doc = isViewer(req) && result.doc ? viewerDocument(result.doc) : result.doc
    return sendSuccess(res, 200, doc, Object.keys(meta).length ? meta : undefined)
  } catch (err) {
    if (err instanceof NoWorkingDraftError) {
      // FLF-177 BUG-31: dự án chưa có nội dung là trạng thái bình thường của một dự án đang làm dở, không
      // phải lỗi. Trả 200 kèm `state` để FE hiện chỗ trống có ý nghĩa, thay vì 78 dòng đỏ 409 ở console.
      // FLF-264: từ khi `GET /document` tự dựng bản thiếu, nhánh này chỉ còn cho project chưa có Spine.
      // `?source=baseline` vẫn là lỗi thật (client đòi một baseline không có).
      if (query.source === "draft") return sendSuccess(res, 200, null, { state: "not_assembled" })
      return sendError(res, err.statusCode, err.code, err.message)
    }
    throw err
  }
})

// ─── GET /document/image ─────────────────────────────────────────

const imageQuerySchema = z.object({ ref: z.string().min(1).max(600) })

const IMAGE_NOT_FOUND = "IMAGE_NOT_FOUND"
const notFound = (): ApiError => new ApiError(404, "Không tìm thấy ảnh này trong tài liệu.", IMAGE_NOT_FOUND)

/**
 * Một ảnh của tài liệu theo chuỗi `image-ref:` mà GET /document trả. Kiểm thành viên (`authorize`), rồi kiểm tham chiếu
 * thuộc đúng dự án: sơ đồ phải có trong `spine.diagrams`; bản dịch chỉ nhận đúng ngôn ngữ tài liệu (khác ngôn ngữ gốc);
 * media chỉ nhận part đang được mục riêng tham chiếu (`custom_sections[].blocks[].image_ref`), không part tuỳ ý trong
 * file. Chỉ đọc — thiếu file ⇒ 404, không vẽ. Hash lệch file đang lưu ⇒ 409 `IMAGE_CHANGED` (FE tải lại tài liệu).
 * URL mang hash nội dung ⇒ cache trình duyệt dài hạn.
 */
export const getDocumentImageController = catchAsync(async (req: Request, res: Response) => {
  const { projectId, documentLanguage, sourceLanguage } = await authorize(req)
  const { ref: token } = parse(imageQuerySchema, req.query)
  const ref = parseImageRef(token)
  if (!ref) throw notFound()
  const spine = await spineRepository.get(projectId)
  if (!spine) throw notFound()
  if (ref.kind === "diagram") {
    if (!spine.diagrams.some((d) => d.id === ref.id)) throw notFound()
    if (ref.locale !== undefined && (ref.locale !== documentLanguage || ref.locale === sourceLanguage)) throw notFound()
  } else {
    const parts = new Set(spine.custom_sections.flatMap((c) => c.blocks.flatMap((b) => (b.kind === "image" && b.image_ref ? [b.image_ref] : []))))
    if (!parts.has(ref.id)) throw notFound()
  }
  const image = await readImageRef(projectId, ref)
  if (!image.ok) {
    if (image.reason === "changed") throw new ApiError(409, "Ảnh này vừa được vẽ lại — tải lại tài liệu để xem bản mới.", "IMAGE_CHANGED")
    throw notFound()
  }
  res.setHeader("Content-Type", image.contentType)
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable")
  res.setHeader("Content-Security-Policy", DIAGRAM_FILE_CSP)
  res.setHeader("X-Content-Type-Options", "nosniff")
  return res.status(200).send(image.data)
})

// ─── GET /version ────────────────────────────────────────────────

/**
 * Nhẹ, để tab đang mở hỏi định kỳ: chỉ đầu Spine + một change + một bản dịch (không dựng tài liệu, không `listChanges`).
 * Mọi vai trò trong org (Viewer có trong allowlist).
 */
export const getVersionController = catchAsync(async (req: Request, res: Response) => {
  const { projectId, documentLanguage, sourceLanguage } = await authorize(req)
  const version = await documentVersion(projectId, { locale: documentLanguage, source: sourceLanguage })
  if (!version) throw new ApiError(404, "Dự án chưa có dữ liệu tài liệu.", "SPINE_NOT_FOUND")
  return sendSuccess(res, 200, version)
})
