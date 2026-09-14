import { Request, Response } from "express"
import { renderedDocumentSchema } from "./rendered-document.schema.js"
import { buildDocxFileName, writeDocx } from "./docx-writer.js"
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
