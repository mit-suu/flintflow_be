/**
 * Controller version + release mode 1 — contract `docs/api/import-change-contract.md` §1 endpoint 12–15, 31. FLF-171.
 */

import { sendSuccess } from "../../shared/types/api-response.js"
import { authorizeMode1, mode1Handler, parseInput } from "../import/mode1.http.js"
import { DOCX_CONTENT_TYPE } from "./doc-file.store.js"
import { compareQuerySchema, downloadQuerySchema, releaseRequestSchema, requestChangesRequestSchema, submitPackageRequestSchema, versionParamsSchema } from "./doc-version.dto.js"
import { getPackage, requestChanges, settleAfterRelease, submitPackage, type PackageActor } from "./review-package.service.js"
import { requireOrgId } from "../../shared/auth/org-request.js"
import { release } from "./release.service.js"
import { compareVersions, downloadVersion, listVersions, toVersionDto, versionBlocks } from "./versions.service.js"
import { IMPORTED_DOC_VERSIONS, isReleaseVersion } from "./versioning.js"
import { isViewer } from "../../shared/auth/viewer-read-scope.middleware.js"
import { ApiError } from "../../shared/utils/api-error.js"

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
  const { variant } = parseInput(downloadQuerySchema, req.query)
  // UC-50: Viewer chỉ tải bản đã phát hành (kể cả v0) — không bản nháp 0.x, không bản đánh dấu theo CR
  if (isViewer(req) && (variant === "tracked" || !(IMPORTED_DOC_VERSIONS.includes(v) || isReleaseVersion(v)))) {
    throw new ApiError(403, "Viewer chỉ tải được phiên bản đã phát hành.", "ORG_ROLE_FORBIDDEN")
  }
  const file = await downloadVersion(auth.projectId, auth.project.name, v, variant)
  res.setHeader("Content-Type", DOCX_CONTENT_TYPE)
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`)
  return res.status(200).send(file.data)
})

export const compare = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req)
  const query = parseInput(compareQuerySchema, req.query)
  return sendSuccess(res, 200, await compareVersions(auth.projectId, query.from, query.to))
})

const packageActor = (req: Parameters<typeof authorizeMode1>[0], auth: Awaited<ReturnType<typeof authorizeMode1>>): PackageActor => ({
  projectId: auth.projectId,
  projectName: auth.project.name,
  orgId: requireOrgId(req),
  userId: auth.userId
})

/** C-7 Lead duyệt cả gói = phát hành; Lead tự làm thì phát hành thẳng (không qua bước gửi). */
export const releaseVersion = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req)
  const body = parseInput(releaseRequestSchema, req.body)
  const result = await release(auth.projectId, auth.userId, body.base_version)
  const spineVersion = await settleAfterRelease(packageActor(req, auth), { version: result.version.version, cr_ids: result.cr_ids, spine_version: result.spine_version })
  return sendSuccess(res, 201, { version: toVersionDto(result.version), baseline: result.baseline, cr_ids: result.cr_ids, spine_version: spineVersion })
})

// ─── gói duyệt (FLF-330) ─────────────────────────────────────────

export const getReviewPackage = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req)
  return sendSuccess(res, 200, await getPackage(auth.projectId))
})

export const submitReviewPackage = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req)
  const body = parseInput(submitPackageRequestSchema, req.body)
  return sendSuccess(res, 200, await submitPackage(packageActor(req, auth), body.base_version))
})

export const requestPackageChanges = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req)
  const body = parseInput(requestChangesRequestSchema, req.body)
  return sendSuccess(res, 200, await requestChanges(packageActor(req, auth), body))
})
