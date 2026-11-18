/**
 * pending-queue.controller.ts
 * ─────────────────────────────────────────────────────────────────
 * GET /projects/:projectId/pending-queue   hàng việc chờ người quyết (FLF-443, endpoint 51) — chỉ đọc, không credit
 * Hợp đồng: docs/api/pipeline-contract.md.
 */

import { Request, Response } from "express"
import mongoose from "mongoose"
import * as spineRepository from "./spine.repository.js"
import { buildPendingQueue } from "./pending-queue.service.js"
import { pendingQueueResponseSchema } from "../pipeline/pipeline.dto.js"
import { getProjectById } from "../project/project.service.js"
import { flagIdsInOpenCrs } from "../change-request/change-request.service.js"
import { requireOrgId } from "../../shared/auth/org-request.js"
import { sendSuccess } from "../../shared/types/api-response.js"
import { catchAsync } from "../../shared/utils/catch-async.js"
import { ApiError } from "../../shared/utils/api-error.js"

export const getPendingQueue = catchAsync(async (req: Request, res: Response) => {
  const projectId = req.params.projectId as string
  if (!mongoose.isValidObjectId(projectId)) {
    throw new ApiError(404, "Không tìm thấy dự án hoặc bạn không có quyền truy cập.", "PROJECT_NOT_FOUND")
  }
  const project = await getProjectById(projectId, requireOrgId(req))
  // Một lần đọc Spine; chưa có Spine ⇒ hàng rỗng (không tạo Spine chỉ vì có người hỏi)
  const spine = await spineRepository.get(projectId)
  // FLF-445: dự án import (chế độ 1) chỉ có cờ, sửa qua change request
  const queue = spine
    ? buildPendingQueue(spine, { flagsInCr: await flagIdsInOpenCrs(projectId), flagsOnly: project.mode === "import" })
    : { total: 0, items: [] }
  return sendSuccess(res, 200, pendingQueueResponseSchema.parse(queue))
})
