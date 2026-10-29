import { Request, Response } from "express"
import { z } from "zod"
import { renderedDocumentSchema } from "./rendered-document.schema.js"
import { buildDocxFileName, writeDocx } from "./docx-writer.js"
import { authorize } from "./render.controller.js"
import { exportWordQuerySchema } from "../pipeline/pipeline.dto.js"
import { getDocumentWithMeta, getDraftMeta, NoWorkingDraftError, type DocumentWithMeta, type DraftMeta } from "./assemble.service.js"
import { assertTranslationComplete, documentLanguageUnavailable } from "../translation/translation.service.js"
import { writerOptionsFor } from "./labels.js"
import { sendError } from "../../shared/types/api-response.js"
import { catchAsync } from "../../shared/utils/catch-async.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { validationError, validationIssues } from "../../shared/utils/validation-message.js"
import { docxToPdf, PdfConverterError } from "../../shared/pdf/gotenberg.client.js"
import { isViewer } from "../../shared/auth/viewer-read-scope.middleware.js"
import type { Spine } from "../spine/spine.types.js"

/** Chi tiết từng issue vào `meta.issues` (debug); user chỉ đọc một câu (FLF-247). */
const renderedDocumentInvalid = (error: z.ZodError): ApiError =>
  new ApiError(422, "Chưa xuất được tài liệu vì nội dung không đúng định dạng. Hãy thử lại sau giây lát.", "RENDERED_DOCUMENT_INVALID", {
    issues: validationIssues(error).slice(0, 20)
  })

/**
 * FLF-334: tên file giữ chữ Unicode của tên dự án ⇒ `filename*=UTF-8''…` (RFC 5987) — dùng chung cho export mode 2 và tải
 * version mode 1. `encodeURIComponent` chừa `'()*`, không hợp lệ trong `attr-char` ⇒ mã hoá thêm.
 */
export const attachmentDisposition = (fileName: string): string =>
  `attachment; filename*=UTF-8''${encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

/** Preview writer từ `RenderedDocument` gửi thẳng. Route thật `GET /projects/:id/export/word` ở render.route.ts (review C1). */
export const previewWord = catchAsync(async (req: Request, res: Response) => {
  if (!req.user?.userId) {
    throw new ApiError(401, "Bạn chưa đăng nhập hoặc phiên đăng nhập đã hết hạn.", "UNAUTHORIZED")
  }

  const parsed = renderedDocumentSchema.safeParse(req.body)
  if (!parsed.success) throw renderedDocumentInvalid(parsed.error)

  const buffer = await writeDocx(parsed.data)
  const fileName = buildDocxFileName(parsed.data)

  res.status(200)
  res.setHeader("Content-Type", DOCX_MIME)
  res.setHeader("Content-Disposition", attachmentDisposition(fileName))
  res.setHeader("Content-Length", String(buffer.length))
  return res.send(buffer)
})

interface ExportedDocx {
  buffer: Buffer
  fileName: string
  documentLanguage: string
  /** `source=draft` — độ mới của bản đang xuất (baseline bất biến, không có). */
  draftMeta: DraftMeta | null
}

/**
 * Phần chung của endpoint 18 (Word) và 34 (PDF): quyền, query, đọc Spine/Baseline qua
 * `assemble.service.ts`, validate `RenderedDocument`, `writeDocx`. PDF là chính buffer này qua
 * Gotenberg (FLF-316) nên hai định dạng không thể lệch nhau về nội dung.
 * `null` ⇒ đã trả lỗi `NO_WORKING_DRAFT` lên `res`.
 */
const buildExportDocx = async (req: Request, res: Response): Promise<ExportedDocx | null> => {
  const { projectId, projectName, mode, documentLanguage, sourceLanguage, convertedFrom } = await authorize(req)
  const parsedQuery = exportWordQuerySchema.safeParse(req.query)
  if (!parsedQuery.success) throw validationError(parsedQuery.error)
  const { lang, ...query } = parsedQuery.data
  // UC-50: Viewer chỉ tải bản đã phát hành — bản nháp (DRAFT) không
  if (isViewer(req) && query.source !== "baseline") {
    throw new ApiError(403, "Viewer chỉ tải được phiên bản đã phát hành.", "ORG_ROLE_FORBIDDEN")
  }
  // FLF-334 B: `?lang=` — không truyền / trùng ngôn ngữ tài liệu ⇒ đúng đường cũ (byte như trước)
  const locale = lang ?? documentLanguage
  const otherLanguage = locale !== documentLanguage
  // Mode 1 (import thật lẫn dự án chuyển từ mode 2): bản đang làm là bản nháp CR — chỉ version có baseline (#14) đổi được ngôn ngữ
  if (otherLanguage && mode === "import") throw documentLanguageUnavailable()

  let result: DocumentWithMeta
  try {
    // Ngôn ngữ khác cần lớp bản dịch ⇒ kiểm đủ TRƯỚC khi dựng, trên đúng Spine sắp dựng (không đọc lại giữa kiểm và
    // dựng): thiếu ⇒ 409, không in chữ gốc thay chỗ thiếu
    const beforeRender = otherLanguage && locale !== sourceLanguage ? (spine: Spine) => assertTranslationComplete(projectId, locale, spine) : undefined
    result = await getDocumentWithMeta(projectId, projectName, { ...query, languages: { locale, source: sourceLanguage }, ...(beforeRender ? { beforeRender } : {}) })
  } catch (err) {
    if (err instanceof NoWorkingDraftError) {
      sendError(res, err.statusCode, err.code, err.message)
      return null
    }
    throw err
  }

  const parsed = renderedDocumentSchema.safeParse(result.doc)
  if (!parsed.success) throw renderedDocumentInvalid(parsed.error)

  const buffer = await writeDocx(parsed.data, writerOptionsFor(mode, locale, convertedFrom))
  // review C2: source=draft — đính kèm độ mới của bản đang xuất (baseline bất biến, không cần).
  // FLF-265: bản dịch không ghi cache ⇒ độ mới của chính bản vừa dựng.
  const draftMeta = query.source === "draft" ? (result.draftMeta ?? (await getDraftMeta(projectId)) ?? null) : null
  return { buffer, fileName: buildDocxFileName(parsed.data, otherLanguage ? locale : undefined), documentLanguage: locale, draftMeta }
}

const sendExport = (res: Response, exported: ExportedDocx, file: Buffer, mime: string, fileName: string) => {
  res.status(200)
  res.setHeader("Content-Type", mime)
  res.setHeader("Content-Disposition", attachmentDisposition(fileName))
  res.setHeader("Content-Length", String(file.length))
  // FLF-265 (contract #18): mọi lần xuất thành công, cả mode 1 — chỉ là header, không đổi file. FLF-334 B: ngôn ngữ của file
  res.setHeader("X-Document-Language", exported.documentLanguage)
  if (exported.draftMeta) {
    res.setHeader("X-Assembled-At-Version", String(exported.draftMeta.assembled_at_version))
    res.setHeader("X-Spine-Version", String(exported.draftMeta.spine_version))
  }
  return res.send(file)
}

/**
 * `GET /projects/:projectId/export/word?source=draft|baseline&baseline_id=&lang=vi|en` — route thật của
 * contract endpoint 18 (mount ở `render.route.ts`, review C1). Không bọc envelope, giống
 * `previewWord`, nhưng đọc Spine/Baseline qua `assemble.service.ts` thay vì nhận `RenderedDocument`
 * trong body.
 */
export const exportWord = catchAsync(async (req: Request, res: Response) => {
  const exported = await buildExportDocx(req, res)
  if (!exported) return
  return sendExport(res, exported, exported.buffer, DOCX_MIME, exported.fileName)
})

export const PDF_MIME = "application/pdf"

/** Tên file PDF = tên file Word đổi đuôi — người nhận thấy ngay hai file là một bản. */
export const toPdfFileName = (docxFileName: string): string => docxFileName.replace(/\.docx$/i, "") + ".pdf"

/**
 * `GET /projects/:projectId/export/pdf?source=draft|baseline&baseline_id=&lang=vi|en` — contract endpoint 34
 * (FLF-316). Cùng query, quyền, mã lỗi và header với #18; khác ở bước cuối: buffer `.docx` đi qua
 * Gotenberg. Gotenberg không chạy / lỗi / quá hạn ⇒ `503 PDF_EXPORT_UNAVAILABLE`, xuất Word không ảnh hưởng.
 */
export const exportPdf = catchAsync(async (req: Request, res: Response) => {
  const exported = await buildExportDocx(req, res)
  if (!exported) return

  let pdf: Buffer
  try {
    pdf = await docxToPdf(exported.buffer, exported.fileName)
  } catch (err) {
    if (!(err instanceof PdfConverterError)) throw err
    console.error(`[export/pdf] ${err.message}`)
    throw new ApiError(
      503,
      "Chưa xuất được PDF lúc này. Bạn hãy thử lại sau ít phút, hoặc tải bản Word.",
      "PDF_EXPORT_UNAVAILABLE"
    )
  }
  return sendExport(res, exported, pdf, PDF_MIME, toPdfFileName(exported.fileName))
})
