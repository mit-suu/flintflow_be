/**
 * Controller version + release mode 1 — contract `docs/api/import-change-contract.md` §1 endpoint 12–15, 31. FLF-171.
 */

import { sendSuccess } from "../../shared/types/api-response.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { docxToPdf, PdfConverterError } from "../../shared/pdf/gotenberg.client.js"
import { PDF_MIME, toPdfFileName } from "../render/export.controller.js"
import { authorizeMode1, mode1Handler, parseInput } from "../import/mode1.http.js"
import { DOCX_CONTENT_TYPE } from "./doc-file.store.js"
import { compareQuerySchema, downloadQuerySchema, releaseRequestSchema, versionParamsSchema } from "./doc-version.dto.js"
import { release } from "./release.service.js"
import { compareVersions, downloadVersion, listVersions, toVersionDto, versionBlocks } from "./versions.service.js"
import { IMPORTED_DOC_VERSIONS, isReleaseVersion } from "./versioning.js"
import { isViewer } from "../../shared/auth/viewer-read-scope.middleware.js"

export const list = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req)
  return sendSuccess(res, 200, await listVersions(auth.projectId))
})

export const blocks = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req)
  const { v } = parseInput(versionParamsSchema, req.params)
  return sendSuccess(res, 200, await versionBlocks(auth.projectId, v))
})

export const download = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req)
  const { v } = parseInput(versionParamsSchema, req.params)
  const { variant, format } = parseInput(downloadQuerySchema, req.query)
  // UC-50: Viewer chỉ tải bản đã phát hành (kể cả v0) — không bản nháp 0.x, không bản đánh dấu theo CR
  if (isViewer(req) && (variant === "tracked" || !(IMPORTED_DOC_VERSIONS.includes(v) || isReleaseVersion(v)))) {
    throw new ApiError(403, "Viewer chỉ tải được phiên bản đã phát hành.", "ORG_ROLE_FORBIDDEN")
  }
  if (format === "pdf" && variant === "original") throw new ApiError(400, "File gốc người dùng upload chỉ tải được dạng .docx.", "VALIDATION_ERROR")
  const file = await downloadVersion(auth.projectId, auth.project.name, v, variant)
  if (format === "pdf") {
    // FLF-316: PDF là chính file .docx vừa dựng (kể cả watermark DRAFT / Track Changes) qua Gotenberg
    let pdf: Buffer
    try {
      pdf = await docxToPdf(file.data, file.filename)
    } catch (err) {
      if (!(err instanceof PdfConverterError)) throw err
      console.error(`[versions/download pdf] ${err.message}`)
      throw new ApiError(503, "Chưa xuất được PDF lúc này. Bạn hãy thử lại sau ít phút, hoặc tải bản Word.", "PDF_EXPORT_UNAVAILABLE")
    }
    res.setHeader("Content-Type", PDF_MIME)
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(toPdfFileName(file.filename))}`)
    return res.status(200).send(pdf)
  }
  res.setHeader("Content-Type", DOCX_CONTENT_TYPE)
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`)
  return res.status(200).send(file.data)
})

export const compare = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req)
  const query = parseInput(compareQuerySchema, req.query)
  return sendSuccess(res, 200, await compareVersions(auth.projectId, query.from, query.to))
})

export const releaseVersion = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req)
  const body = parseInput(releaseRequestSchema, req.body)
  const result = await release(auth.projectId, auth.userId, body.base_version)
  return sendSuccess(res, 201, { version: toVersionDto(result.version), baseline: result.baseline, cr_ids: result.cr_ids, spine_version: result.spine_version })
})
