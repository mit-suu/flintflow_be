/**
 * Helper HTTP dùng chung cho controller mode 1 (import, versions, change request, release). FLF-171.
 * Kiểm quyền sở hữu + `mode = import` TRƯỚC khi đọc body (người ngoài không dò được DTO qua lỗi 400),
 * trả `Mode1Error` kèm `meta` đúng envelope của contract §0.3.
 */

import type { Request, Response } from "express"
import mongoose from "mongoose"
import { z } from "zod"
import type { IProject } from "../project/project.model.js"
import { getProjectById } from "../project/project.service.js"
import { sendError } from "../../shared/types/api-response.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { catchAsync } from "../../shared/utils/catch-async.js"
import { Mode1Error } from "./mode1.errors.js"

export interface Mode1Auth {
  projectId: string
  userId: string
  project: IProject
}

export const authorizeMode1 = async (req: Request): Promise<Mode1Auth> => {
  const userId = req.user?.userId
  if (!userId) throw new ApiError(401, "User not authenticated", "UNAUTHORIZED")
  const projectId = req.params.projectId as string
  if (!mongoose.isValidObjectId(projectId)) throw new ApiError(404, "Project not found or unauthorized", "PROJECT_NOT_FOUND")
  const project = await getProjectById(projectId, userId)
  const mode = project.mode ?? "fpt"
  if (mode !== "import") {
    throw new Mode1Error("PROJECT_MODE_MISMATCH", "API này chỉ dùng cho project upload SRS có sẵn (mode import)", { mode, expected: "import" })
  }
  return { projectId, userId, project }
}

export const parseInput = <T extends z.ZodType>(schema: T, value: unknown): z.infer<T> => {
  const parsed = schema.safeParse(value ?? {})
  if (!parsed.success) throw new ApiError(400, z.prettifyError(parsed.error), "VALIDATION_ERROR")
  return parsed.data
}

/** Bọc handler: `Mode1Error` ⇒ envelope có `meta`; lỗi khác đi tiếp tới error handler chung. */
export const mode1Handler = (fn: (req: Request, res: Response) => Promise<Response | void>) =>
  catchAsync(async (req: Request, res: Response) => {
    try {
      return await fn(req, res)
    } catch (err) {
      if (err instanceof Mode1Error) return sendError(res, err.statusCode, err.code, err.message, err.meta)
      throw err
    }
  })

export const toIso = (d: Date | null | undefined): string | null => (d ? new Date(d).toISOString() : null)
