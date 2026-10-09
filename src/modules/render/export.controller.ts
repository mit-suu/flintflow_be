import { Request, Response } from "express"
import { z } from "zod"
import { renderedDocumentSchema } from "./rendered-document.schema.js"
import { buildDocxFileName, writeDocx } from "./docx-writer.js"
import { authorize } from "./render.controller.js"
import { exportWordQuerySchema } from "../pipeline/pipeline.dto.js"
import { getDocumentWithMeta, getDraftMeta, NoWorkingDraftError, type DocumentWithMeta } from "./assemble.service.js"
import { writerOptionsFor } from "./labels.js"
import { sendError } from "../../shared/types/api-response.js"
import { catchAsync } from "../../shared/utils/catch-async.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { validationError, validationIssues } from "../../shared/utils/validation-message.js"

/** Chi tiết từng issue vào `meta.issues` (debug); user chỉ đọc một câu (FLF-247). */
const renderedDocumentInvalid = (error: z.ZodError): ApiError =>
  new ApiError(422, "Chưa xuất được tài liệu vì nội dung không đúng định dạng. Hãy thử lại sau giây lát.", "RENDERED_DOCUMENT_INVALID", {
    issues: validationIssues(error).slice(0, 20)
  })

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
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`)
  res.setHeader("Content-Length", String(buffer.length))
  return res.send(buffer)
})

/**
 * `GET /projects/:projectId/export/word?source=draft|baseline&baseline_id=` — route thật của
 * contract endpoint 18 (mount ở `render.route.ts`, review C1). Không bọc envelope, giống
 * `previewWord`, nhưng đọc Spine/Baseline qua `assemble.service.ts` thay vì nhận `RenderedDocument`
 * trong body.
 */
export const exportWord = catchAsync(async (req: Request, res: Response) => {
  const { projectId, projectName, mode, documentLanguage, sourceLanguage } = await authorize(req)
  const parsedQuery = exportWordQuerySchema.safeParse(req.query)
  if (!parsedQuery.success) throw validationError(parsedQuery.error)

  let result: DocumentWithMeta
  try {
    // FLF-265: ngôn ngữ theo project, không theo query (`exportWordQuerySchema` đóng băng)
    result = await getDocumentWithMeta(projectId, projectName, { ...parsedQuery.data, languages: { locale: documentLanguage, source: sourceLanguage } })
  } catch (err) {
    if (err instanceof NoWorkingDraftError) return sendError(res, err.statusCode, err.code, err.message)
    throw err
  }

  const parsed = renderedDocumentSchema.safeParse(result.doc)
  if (!parsed.success) throw renderedDocumentInvalid(parsed.error)

  const buffer = await writeDocx(parsed.data, writerOptionsFor(mode, documentLanguage))
  const fileName = buildDocxFileName(parsed.data)

  res.status(200)
  res.setHeader("Content-Type", DOCX_MIME)
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`)
  res.setHeader("Content-Length", String(buffer.length))
  // FLF-265 (contract #18): mọi lần xuất thành công, cả mode 1 — chỉ là header, không đổi file
  res.setHeader("X-Document-Language", documentLanguage)
  // review C2: source=draft — đính kèm độ mới của bản đang xuất (baseline bất biến, không cần).
  // FLF-265: bản dịch không ghi cache ⇒ độ mới của chính bản vừa dựng.
  if (parsedQuery.data.source === "draft") {
    const meta = result.draftMeta ?? (await getDraftMeta(projectId))
    if (meta) {
      res.setHeader("X-Assembled-At-Version", String(meta.assembled_at_version))
      res.setHeader("X-Spine-Version", String(meta.spine_version))
    }
  }
  return res.send(buffer)
})
