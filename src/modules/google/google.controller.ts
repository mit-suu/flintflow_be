import { Request, Response } from "express"
import mongoose from "mongoose"
import * as googleAuthService from "./google-auth.service.js"
import { linkProjectDoc, listProjectLinks as listLinksOfProject, unlinkProjectDoc } from "./google-doc-links.service.js"
import { getProjectById } from "../project/project.service.js"
import { requireOrgId } from "../../shared/auth/org-request.js"
import { sendSuccess } from "../../shared/types/api-response.js"
import { catchAsync } from "../../shared/utils/catch-async.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { validationError } from "../../shared/utils/validation-message.js"
import { LinkGoogleDocSchema, type ConnectGoogleDTO } from "./google.validation.js"

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

/** Đã đăng nhập, tích hợp đang bật, dự án thuộc org đang mở (không thì PROJECT_NOT_FOUND). */
const authorizeProject = async (req: Request): Promise<{ userId: string; projectId: string }> => {
  const userId = requireUserId(req)
  googleAuthService.assertGoogleIntegrationEnabled()
  const projectId = req.params.projectId as string
  if (!mongoose.isValidObjectId(projectId)) {
    throw new ApiError(404, "Không tìm thấy dự án hoặc bạn không có quyền truy cập.", "PROJECT_NOT_FOUND")
  }
  await getProjectById(projectId, requireOrgId(req))
  return { userId, projectId }
}

/** `GET /projects/:projectId/google-docs/links` (contract #45) — Google Doc của dự án, mọi thành viên. */
export const listProjectLinks = catchAsync(async (req: Request, res: Response) => {
  const { userId, projectId } = await authorizeProject(req)
  return sendSuccess(res, 200, await listLinksOfProject(projectId, userId))
})

/** `POST /projects/:projectId/google-docs/links` `{ fileId }` (contract #45a) — liên kết Google Doc chọn từ Picker. */
export const linkProjectDocument = catchAsync(async (req: Request, res: Response) => {
  const { userId, projectId } = await authorizeProject(req)
  const body = LinkGoogleDocSchema.safeParse(req.body ?? {})
  if (!body.success) throw validationError(body.error)
  const auth = await googleAuthService.getAuthClient(userId)
  return sendSuccess(res, 200, await linkProjectDoc(auth, projectId, userId, body.data.fileId))
})

/** `DELETE /projects/:projectId/google-docs/links/:fileId` (contract #45b) — bỏ khỏi dự án, file trên Drive giữ nguyên. */
export const unlinkProjectDocument = catchAsync(async (req: Request, res: Response) => {
  const { projectId } = await authorizeProject(req)
  const params = LinkGoogleDocSchema.safeParse({ fileId: req.params.fileId })
  if (!params.success) throw validationError(params.error)
  return sendSuccess(res, 200, await unlinkProjectDoc(projectId, params.data.fileId))
})

export const getAccessToken = catchAsync(async (req: Request, res: Response) => {
  // Access token sống ~1 giờ — không để proxy / trình duyệt cache
  res.set("Cache-Control", "no-store")
  return sendSuccess(res, 200, await googleAuthService.getAccessToken(requireUserId(req)))
})
