import { Request, Response } from "express"
import mongoose from "mongoose"
import { z } from "zod"
import * as commentService from "./comment.service.js"
import { commentParamsSchema, createCommentSchema, listCommentsQuerySchema, replyCommentSchema } from "./comment.validation.js"
import { getProjectById } from "../project/project.service.js"
import { requireOrgId } from "../../shared/auth/org-request.js"
import { sendSuccess } from "../../shared/types/api-response.js"
import { catchAsync } from "../../shared/utils/catch-async.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { validationError } from "../../shared/utils/validation-message.js"

const parse = <T extends z.ZodType>(schema: T, input: unknown): z.infer<T> => {
  const parsed = schema.safeParse(input ?? {})
  if (!parsed.success) throw validationError(parsed.error)
  return parsed.data
}

/** Kiểm project thuộc org đang mở TRƯỚC khi đọc body — người ngoài không dò được DTO qua lỗi 400. */
const authorize = async (req: Request): Promise<commentService.CommentActor> => {
  const userId = req.user?.userId
  if (!userId) throw new ApiError(401, "Bạn chưa đăng nhập hoặc phiên đăng nhập đã hết hạn.", "UNAUTHORIZED")
  const role = req.orgContext?.role
  if (!role) throw new ApiError(500, "Hệ thống gặp lỗi khi xử lý yêu cầu. Vui lòng thử lại sau.", "ORG_CONTEXT_MISSING")
  const projectId = req.params.projectId as string
  if (!mongoose.isValidObjectId(projectId)) throw new ApiError(404, "Không tìm thấy dự án hoặc bạn không có quyền truy cập.", "PROJECT_NOT_FOUND")
  const orgId = requireOrgId(req)
  const project = await getProjectById(projectId, orgId)
  return { projectId, projectName: project.name, orgId, userId, role }
}

export const listComments = catchAsync(async (req: Request, res: Response) => {
  const actor = await authorize(req)
  const { status } = parse(listCommentsQuerySchema, req.query)
  return sendSuccess(res, 200, await commentService.listComments(actor.projectId, status))
})

export const createComment = catchAsync(async (req: Request, res: Response) => {
  const actor = await authorize(req)
  const body = parse(createCommentSchema, req.body)
  return sendSuccess(res, 201, await commentService.createComment(actor, body))
})

export const replyComment = catchAsync(async (req: Request, res: Response) => {
  const actor = await authorize(req)
  const { commentId } = parse(commentParamsSchema, req.params)
  const { text } = parse(replyCommentSchema, req.body)
  return sendSuccess(res, 201, await commentService.replyComment(actor, commentId, text))
})

export const resolveComment = catchAsync(async (req: Request, res: Response) => {
  const actor = await authorize(req)
  const { commentId } = parse(commentParamsSchema, req.params)
  return sendSuccess(res, 200, await commentService.resolveComment(actor, commentId))
})
