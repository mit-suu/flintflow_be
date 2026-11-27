/**
 * GET  /projects/:projectId/diagrams                        danh sách `diagrams[]` + cờ stale + link file
 * GET  /projects/:projectId/diagrams/:diagramId.svg|.png    file đã render (GridFS)
 * POST /projects/:projectId/diagrams/:kind/render            render thủ công (dev); `kind = all` render cả bộ
 * POST /projects/:projectId/diagrams/render                  vẽ lại đúng các hình theo danh sách id, rồi tính lại cờ
 */

import { Request, Response } from "express"
import mongoose from "mongoose"
import { z } from "zod"
import * as spineRepository from "../spine/spine.repository.js"
import type { SpineRecord } from "../spine/spine.types.js"
import { getProjectById } from "../project/project.service.js"
import { requireOrgId } from "../../shared/auth/org-request.js"
import { sendSuccess } from "../../shared/types/api-response.js"
import { catchAsync } from "../../shared/utils/catch-async.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { validationError } from "../../shared/utils/validation-message.js"
import * as diagramService from "./diagram.service.js"
import { loadRenderContext } from "./render-context.js"
import { assertPackageNotPending } from "../doc-version/review-package.service.js"
import { isViewer } from "../../shared/auth/viewer-read-scope.middleware.js"
import { viewerSpine } from "../../shared/auth/viewer-spine.js"
import { DIAGRAM_KINDS } from "./renderers/index.js"
import * as flagsService from "../spine/flags.service.js"
import { nextStep } from "../pipeline/step-registry.js"
import { mode1RuleProfileFor } from "../import/mode1-guard.js"

const context = async (req: Request): Promise<{ projectId: string; userId: string; spine: SpineRecord }> => {
  const userId = req.user?.userId
  if (!userId) throw new ApiError(401, "Bạn chưa đăng nhập hoặc phiên đăng nhập đã hết hạn.", "UNAUTHORIZED")
  const projectId = req.params.projectId as string
  if (!mongoose.isValidObjectId(projectId)) throw new ApiError(404, "Không tìm thấy dự án hoặc bạn không có quyền truy cập.", "PROJECT_NOT_FOUND")
  const project = await getProjectById(projectId, requireOrgId(req))
  // FLF-466: Viewer đọc sơ đồ theo bản ổn định mới nhất, không theo Spine sống
  const spine = isViewer(req)
    ? ({ ...(await viewerSpine(projectId)), projectId } as unknown as SpineRecord)
    : await spineRepository.getOrCreate(projectId, { name: project.name, domain: project.domain ?? null })
  return { projectId, userId, spine }
}

const FILE_RE = /^(.+)\.(svg|png)$/

export const listDiagrams = catchAsync(async (req: Request, res: Response) => {
  const { projectId, spine } = await context(req)
  const stale = new Set(diagramService.staleDiagrams(spine, await loadRenderContext(projectId)).map((d) => d.id))
  const base = `/api/v1/projects/${projectId}/diagrams`
  return sendSuccess(
    res,
    200,
    spine.diagrams.map((d) => ({
      ...d,
      stale: stale.has(d.id),
      files: d.render_status === "ok" ? { svg: `${base}/${d.id}.svg`, png: `${base}/${d.id}.png` } : null
    }))
  )
})

export const DIAGRAM_FILE_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox"

export const getDiagramFile = catchAsync(async (req: Request, res: Response) => {
  const { projectId, spine } = await context(req)
  const match = FILE_RE.exec(String(req.params.file))
  if (!match) throw new ApiError(404, "Không tìm thấy sơ đồ này.", diagramService.DIAGRAM_NOT_FOUND)
  const [, diagramId, format] = match
  if (!spine.diagrams.some((d) => d.id === diagramId)) {
    throw new ApiError(404, "Không tìm thấy sơ đồ này.", diagramService.DIAGRAM_NOT_FOUND)
  }
  const file = await diagramService.loadDiagramFile(projectId, diagramId, format === "svg" ? "svg" : "png")
  res.setHeader("Content-Type", file.contentType)
  res.setHeader("Cache-Control", "private, no-cache")
  // SVG tự dựng chứa chữ user (FLF-339): mở thẳng file cũng không chạy được script / tải tài nguyên ngoài
  res.setHeader("Content-Security-Policy", DIAGRAM_FILE_CSP)
  res.setHeader("X-Content-Type-Options", "nosniff")
  return res.status(200).send(file.data)
})

const renderBodySchema = z.object({
  owner_id: z.string().min(1).nullable().optional(),
  /** Compile lại cả hình có dữ liệu nguồn không đổi. */
  force: z.boolean().optional()
})

export const renderDiagramRoute = catchAsync(async (req: Request, res: Response) => {
  const kind = String(req.params.kind)
  const body = renderBodySchema.safeParse(req.body ?? {})
  if (!body.success) throw validationError(body.error)

  const known = DIAGRAM_KINDS.find((k) => k === kind)
  if (kind !== "all" && !known) {
    throw new ApiError(400, "Loại sơ đồ không hợp lệ.", "VALIDATION_ERROR", { allowed: ["all", ...DIAGRAM_KINDS] })
  }
  const ownerId = body.data.owner_id ?? null
  if (known === "screen_layout" && ownerId === null) throw new ApiError(400, "Cần chọn màn hình để vẽ sơ đồ bố cục màn.", "VALIDATION_ERROR")

  const { projectId, userId, spine } = await context(req)
  assertPackageNotPending(spine.baseline_submission)
  const options = { by: userId, force: body.data.force ?? false, deps: diagramService.layoutRenderDeps() }
  const result = known
    ? await diagramService.renderDiagram(projectId, known, known === "screen_layout" ? ownerId : null, options)
    : await diagramService.renderAll(projectId, options)
  return sendSuccess(res, 200, result)
})

const renderByIdsBodySchema = z.strictObject({
  diagram_ids: z.array(z.string().min(1)).min(1).max(200),
  /** Compile lại cả hình có dữ liệu nguồn không đổi. Mặc định `true`: nút "Vẽ lại" của người dùng. */
  force: z.boolean().optional()
})

/**
 * Vẽ lại đúng các hình trong danh sách (không compile hình khác, không gỡ hình nào), rồi tính lại cờ để cờ `diagram_stale`
 * của các hình vừa vẽ tắt ngay — FE không cần gọi recompute riêng. Giữ `assertPackageNotPending` như route theo loại.
 */
export const renderDiagramsByIdsRoute = catchAsync(async (req: Request, res: Response) => {
  const body = renderByIdsBodySchema.safeParse(req.body ?? {})
  if (!body.success) throw validationError(body.error)
  const { projectId, userId, spine } = await context(req)
  assertPackageNotPending(spine.baseline_submission)
  const ids = [...new Set(body.data.diagram_ids)]
  const startedAt = Date.now()
  const result = await diagramService.renderDiagramsByIds(projectId, ids, { by: userId, force: body.data.force ?? true, deps: diagramService.layoutRenderDeps() })
  // Dự án chế độ nhập tài liệu luôn ở sau baseline v0 (cùng cách ghi CR tính cờ); chế độ khác: theo step đang đứng
  const project = await getProjectById(projectId, requireOrgId(req))
  const isImport = project.mode === "import"
  const recomputed = await flagsService.recompute(projectId, {
    by: userId,
    atBaseline: isImport ? true : nextStep(spine)?.phase === "S-9",
    ...(isImport ? { ruleProfile: await mode1RuleProfileFor(projectId) } : {})
  })
  console.info(`[diagram] vẽ lại theo danh sách ${ids.length} hình (project ${projectId}): ${result.rendered.length} hình đã vẽ, ${Date.now() - startedAt}ms`)
  return sendSuccess(res, 200, {
    spine_version: recomputed.checked_at_version,
    rendered: result.rendered,
    skipped: result.skipped ?? [],
    flags: recomputed.flags
  })
})
