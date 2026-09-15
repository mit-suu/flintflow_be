import { Request, Response } from "express"
import { z } from "zod"
import { renderedDocumentSchema } from "./rendered-document.schema.js"
import { buildDocxFileName, writeDocx } from "./docx-writer.js"
import { authorize } from "./render.controller.js"
import { exportWordQuerySchema } from "../pipeline/pipeline.dto.js"
import { getDocument, NoWorkingDraftError } from "./assemble.service.js"
import { sendError } from "../../shared/types/api-response.js"
import { catchAsync } from "../../shared/utils/catch-async.js"
import { ApiError } from "../../shared/utils/api-error.js"

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

/** Preview writer từ `RenderedDocument` gửi thẳng. Route thật `GET /projects/:id/export/word` do T15 thêm. */
export const previewWord = catchAsync(async (req: Request, res: Response) => {
  if (!req.user?.userId) {
    throw new ApiError(401, "User not authenticated", "UNAUTHORIZED")
  }

  const parsed = renderedDocumentSchema.safeParse(req.body)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ")
    throw new ApiError(422, `Invalid RenderedDocument — ${detail}`, "RENDERED_DOCUMENT_INVALID")
  }

  const buffer = await writeDocx(parsed.data)
  const fileName = buildDocxFileName(parsed.data)

  res.status(200)
  res.setHeader("Content-Type", DOCX_MIME)
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`)
  res.setHeader("Content-Length", String(buffer.length))
  return res.send(buffer)
})

/**
 * `GET /projects/:projectId/export/word?source=draft|baseline&baseline_id=` (T15) — route thật của
 * contract endpoint 18. Không bọc envelope, giống `previewWord`, nhưng đọc Spine/Baseline qua
 * `assemble.service.ts` thay vì nhận `RenderedDocument` trong body.
 */
export const exportWord = catchAsync(async (req: Request, res: Response) => {
  const { projectId, projectName } = await authorize(req)
  const parsedQuery = exportWordQuerySchema.safeParse(req.query)
  if (!parsedQuery.success) throw new ApiError(400, z.prettifyError(parsedQuery.error), "VALIDATION_ERROR")

  let doc
  try {
    doc = await getDocument(projectId, projectName, parsedQuery.data)
  } catch (err) {
    if (err instanceof NoWorkingDraftError) return sendError(res, err.statusCode, err.code, err.message, { hint: "S-8.2" })
    throw err
  }

  const parsed = renderedDocumentSchema.safeParse(doc)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ")
    throw new ApiError(422, `Invalid RenderedDocument — ${detail}`, "RENDERED_DOCUMENT_INVALID")
  }

  const buffer = await writeDocx(parsed.data)
  const fileName = buildDocxFileName(parsed.data)

  res.status(200)
  res.setHeader("Content-Type", DOCX_MIME)
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`)
  res.setHeader("Content-Length", String(buffer.length))
  return res.send(buffer)
})
