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
import { assembleRequestSchema, assembleResponseSchema, documentQuerySchema } from "../pipeline/pipeline.dto.js"
import { assemble, getDocument, getDraftMeta, NoWorkingDraftError } from "./assemble.service.js"
import { sendError, sendSuccess } from "../../shared/types/api-response.js"
import { catchAsync } from "../../shared/utils/catch-async.js"
import { ApiError } from "../../shared/utils/api-error.js"

const parse = <T extends z.ZodType>(schema: T, input: unknown): z.infer<T> => {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new ApiError(400, z.prettifyError(parsed.error), "VALIDATION_ERROR")
  return parsed.data
}

interface Context {
  projectId: string
  projectName: string
}

/** Kiểm quyền sở hữu project trước khi đọc body/query — người ngoài không dò được DTO qua lỗi 400. */
export const authorize = async (req: Request): Promise<Context> => {
  const userId = req.user?.userId
  if (!userId) throw new ApiError(401, "User not authenticated", "UNAUTHORIZED")

  const projectId = req.params.projectId as string
  if (!mongoose.isValidObjectId(projectId)) throw new ApiError(404, "Project not found or unauthorized", "PROJECT_NOT_FOUND")
  const project = await getProjectById(projectId, requireOrgId(req))
  return { projectId, projectName: project.name }
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
  const { projectId, projectName } = await authorize(req)
  const query = parse(documentQuerySchema, req.query)

  try {
    const doc = await getDocument(projectId, projectName, query)
    // review C2: source=draft trước đây trả im lặng bản cache mới nhất dù Spine đã đổi tiếp — đính
    // kèm độ mới để caller (FE) tự quyết định có báo "tài liệu đang xem đã cũ" hay không.
    const draftMeta = query.source === "draft" ? await getDraftMeta(projectId) : null
    return sendSuccess(
      res,
      200,
      doc,
      draftMeta
        ? { assembled_at_version: draftMeta.assembled_at_version, spine_version: draftMeta.spine_version, stale: draftMeta.stale }
        : undefined
    )
  } catch (err) {
    if (err instanceof NoWorkingDraftError) return sendError(res, err.statusCode, err.code, err.message, { hint: "S-8.2" })
    throw err
  }
})
