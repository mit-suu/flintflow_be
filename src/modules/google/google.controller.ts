import { Request, Response } from "express"
import mongoose from "mongoose"
import * as googleAuthService from "./google-auth.service.js"
import { listLinks } from "./google-export.service.js"
import { getProjectById } from "../project/project.service.js"
import { requireOrgId } from "../../shared/auth/org-request.js"
import { isViewer } from "../../shared/auth/viewer-read-scope.middleware.js"
import { sendSuccess } from "../../shared/types/api-response.js"
import { catchAsync } from "../../shared/utils/catch-async.js"
import { ApiError } from "../../shared/utils/api-error.js"
import type { ConnectGoogleDTO } from "./google.validation.js"

const requireUserId = (req: Request): string => {
  const userId = req.user?.userId
  if (!userId) {
    throw new ApiError(401, "Bạn chưa đăng nhập hoặc phiên đăng nhập đã hết hạn.", "UNAUTHORIZED")
  }
  return userId
}

export const connect = catchAsync(async (req: Request, res: Response) => {
  const { code } = req.body as ConnectGoogleDTO
  return sendSuccess(res, 200, await googleAuthService.connect(requireUserId(req), code))
})

export const getStatus = catchAsync(async (req: Request, res: Response) =>
  sendSuccess(res, 200, await googleAuthService.getStatus(requireUserId(req)))
)

export const disconnect = catchAsync(async (req: Request, res: Response) =>
  sendSuccess(res, 200, await googleAuthService.disconnect(requireUserId(req)))
)

/** `GET /projects/:projectId/google-docs/links` (contract #45) — Google Doc user hiện tại đã xuất trong dự án. */
export const listProjectLinks = catchAsync(async (req: Request, res: Response) => {
  const userId = requireUserId(req)
  googleAuthService.assertGoogleIntegrationEnabled()
  const projectId = req.params.projectId as string
  if (!mongoose.isValidObjectId(projectId)) {
    throw new ApiError(404, "Không tìm thấy dự án hoặc bạn không có quyền truy cập.", "PROJECT_NOT_FOUND")
  }
  // Ném PROJECT_NOT_FOUND nếu dự án không thuộc org đang mở
  await getProjectById(projectId, requireOrgId(req))
  const links = await listLinks(projectId, userId)
  return sendSuccess(res, 200, isViewer(req) ? links.filter((l) => l.source === "baseline") : links)
})

export const getAccessToken = catchAsync(async (req: Request, res: Response) => {
  // Access token sống ~1 giờ — không để proxy / trình duyệt cache
  res.set("Cache-Control", "no-store")
  return sendSuccess(res, 200, await googleAuthService.getAccessToken(requireUserId(req)))
})
