/**
 * render.controller.ts
 * ─────────────────────────────────────────────────────────────────
 * POST /projects/:projectId/assemble               S-8.2 ghép RenderedDocument, cache
 * GET  /projects/:projectId/document?source=&baseline_id=   trả RenderedDocument
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
import { sendError, sendSuccess } from "../../shared/types/api-response.js"
import { catchAsync } from "../../shared/utils/catch-async.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { validationError } from "../../shared/utils/validation-message.js"

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
  return { projectId, projectName: project.name, mode: (project as { mode?: string }).mode, documentLanguage: locale, sourceLanguage: source }
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

  try {
    // FLF-265: ngôn ngữ lấy từ project (`documentQuerySchema` đóng băng — `?lang=` bị parse lọc bỏ)
    const result = await getDocumentWithMeta(projectId, projectName, { ...query, languages: { locale: documentLanguage, source: sourceLanguage } })
    // review C2: source=draft trước đây trả im lặng bản cache mới nhất dù Spine đã đổi tiếp — đính
    // kèm độ mới để caller (FE) tự quyết định có báo "tài liệu đang xem đã cũ" hay không.
    // FLF-265: bản dịch dựng mới mỗi lần, không ghi cache ⇒ độ mới lấy từ chính bản vừa dựng.
    const draftMeta = query.source === "draft" ? (result.draftMeta ?? (await getDraftMeta(projectId))) : null
    const meta = {
      ...(draftMeta
        ? { assembled_at_version: draftMeta.assembled_at_version, spine_version: draftMeta.spine_version, stale: draftMeta.stale }
        : {}),
      // Chỉ khi ngôn ngữ tài liệu ≠ ngôn ngữ gốc (contract #16) — draft lẫn baseline
      ...(result.translation ? { translation: documentTranslationMetaSchema.parse(result.translation) } : {})
    }
    return sendSuccess(res, 200, result.doc, Object.keys(meta).length ? meta : undefined)
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
