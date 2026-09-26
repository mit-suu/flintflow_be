import { Request, Response } from "express"
import mongoose from "mongoose"
import * as spineRepository from "./spine.repository.js"
import { getProjectById } from "../project/project.service.js"
import { requireOrgId } from "../../shared/auth/org-request.js"
import { sendSuccess } from "../../shared/types/api-response.js"
import { catchAsync } from "../../shared/utils/catch-async.js"
import { ApiError } from "../../shared/utils/api-error.js"

export const getSpine = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId
  if (!userId) {
    throw new ApiError(401, "User not authenticated", "UNAUTHORIZED")
  }

  const projectId = req.params.projectId as string
  // id sai định dạng: trả 404 như project không thuộc user, không để CastError thành 500
  if (!mongoose.isValidObjectId(projectId)) {
    throw new ApiError(404, "Project not found or unauthorized", "PROJECT_NOT_FOUND")
  }

  const project = await getProjectById(projectId, requireOrgId(req))
  // Project tạo trước T01 chưa có Spine: tạo rỗng lần đầu đọc (T21 sẽ migrate nội dung)
  const spine = await spineRepository.getOrCreate(projectId, {
    name: project.name,
    domain: project.domain ?? null
  })
  return sendSuccess(res, 200, spine)
})
