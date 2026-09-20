/**
 * Controller version + release mode 1 — contract `docs/api/import-change-contract.md` §1 endpoint 12–15, 31. FLF-171.
 */

import { sendSuccess } from "../../shared/types/api-response.js"
import { authorizeMode1, mode1Handler, parseInput } from "../import/mode1.http.js"
import { DOCX_CONTENT_TYPE } from "./doc-file.store.js"
import { compareQuerySchema, downloadQuerySchema, releaseRequestSchema, versionParamsSchema } from "./doc-version.dto.js"
import { release } from "./release.service.js"
import { compareVersions, downloadVersion, listVersions, toVersionDto, versionBlocks } from "./versions.service.js"

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

export const releaseVersion = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req)
  const body = parseInput(releaseRequestSchema, req.body)
  const result = await release(auth.projectId, auth.userId, body.base_version)
  return sendSuccess(res, 201, { version: toVersionDto(result.version), baseline: result.baseline, cr_ids: result.cr_ids, spine_version: result.spine_version })
})
