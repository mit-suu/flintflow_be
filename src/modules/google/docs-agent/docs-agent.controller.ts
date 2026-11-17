import { Request, Response } from "express"
import mongoose from "mongoose"
import { z } from "zod"
import { getProjectById } from "../../project/project.service.js"
import { requireOrgId } from "../../../shared/auth/org-request.js"
import { sendSuccess } from "../../../shared/types/api-response.js"
import { catchAsync } from "../../../shared/utils/catch-async.js"
import { ApiError } from "../../../shared/utils/api-error.js"
import { toClientError } from "../../../shared/utils/client-error.js"
import { validationError } from "../../../shared/utils/validation-message.js"
import { HISTORY_MAX, applyPendingAction, dismissPendingAction, openAgentTurn, type AgentEvent } from "./docs-agent.service.js"

export const AgentMessageSchema = z.object({
  documentId: z.string().trim().min(1).max(200).regex(/^[\w-]+$/),
  message: z.string().trim().min(1).max(4000),
  /** Tối đa 12 tin gần nhất, FE giữ — BE không lưu hội thoại. */
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(8000) }))
    .max(HISTORY_MAX)
    .default([])
})

const authorizeProject = async (req: Request): Promise<{ projectId: string; userId: string; orgId: string }> => {
  const userId = req.user?.userId
  if (!userId) throw new ApiError(401, "Bạn chưa đăng nhập hoặc phiên đăng nhập đã hết hạn.", "UNAUTHORIZED")
  const projectId = req.params.projectId as string
  if (!mongoose.isValidObjectId(projectId)) {
    throw new ApiError(404, "Không tìm thấy dự án hoặc bạn không có quyền truy cập.", "PROJECT_NOT_FOUND")
  }
  const orgId = requireOrgId(req)
  await getProjectById(projectId, orgId)
  return { projectId, userId, orgId }
}

/**
 * `POST /projects/:projectId/google-docs/agent/messages/stream` (contract #48) — SSE như chat: `tool-call { name, args }`,
 * `text-delta { delta }`, rồi `finish { data: { reply, pending_actions }, tokensUsed, cost }` hoặc `error { error, code }`.
 * Lỗi trước khi mở luồng (chưa nối Google, không có quyền với tài liệu) trả JSON như endpoint thường.
 */
export const streamMessage = catchAsync(async (req: Request, res: Response) => {
  const { projectId, userId, orgId } = await authorizeProject(req)
  const parsed = AgentMessageSchema.safeParse(req.body ?? {})
  if (!parsed.success) throw validationError(parsed.error)
  const body = parsed.data

  // Nút dừng ở FE = huỷ fetch ⇒ ngắt lượt gọi model, hoàn credit (như chat)
  const stop = new AbortController()
  res.on("close", () => {
    if (!res.writableEnded) stop.abort()
  })

  const turn = await openAgentTurn({ projectId, userId, activeOrgId: orgId, ...body, signal: stop.signal })
  try {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8")
    res.setHeader("Cache-Control", "no-cache, no-transform")
    res.setHeader("Connection", "keep-alive")
    res.setHeader("X-Accel-Buffering", "no")
    res.flushHeaders?.()
    const write = (event: AgentEvent | Record<string, unknown>) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`)
    }
    try {
      const result = await turn.run(write)
      write({
        type: "finish",
        data: { reply: result.reply, pending_actions: result.pendingActions, document_title: turn.documentTitle },
        tokensUsed: result.tokensUsed,
        cost: result.cost
      })
    } catch (err) {
      const { code, message } = toClientError(err)
      write({ type: "error", error: message, code })
    }
    res.end()
  } finally {
    await turn.close()
  }
})

/** `POST …/agent/actions/:actionId/apply` (contract #49) — Lead, Analyst; miễn phí. */
export const applyAction = catchAsync(async (req: Request, res: Response) => {
  const { projectId, userId } = await authorizeProject(req)
  return sendSuccess(res, 200, await applyPendingAction(projectId, userId, req.params.actionId as string))
})

/** `POST …/agent/actions/:actionId/dismiss` (contract #50) — Lead, Analyst; miễn phí. */
export const dismissAction = catchAsync(async (req: Request, res: Response) => {
  const { projectId, userId } = await authorizeProject(req)
  return sendSuccess(res, 200, await dismissPendingAction(projectId, userId, req.params.actionId as string))
})
