/**
 * pipeline.controller.ts
 * ─────────────────────────────────────────────────────────────────
 * GET  /projects/:projectId/steps                    danh sách step + tiến độ trần
 * POST /projects/:projectId/steps/:stepId/run         chạy step (SSE) — step-runner.service
 * POST /projects/:projectId/steps/:stepId/answer      trả lời Elicit đang chờ (answer_needed)
 * POST /projects/:projectId/steps/:stepId/gate        accept/revision/regenerate/accept_as_is
 * POST /projects/:projectId/resume                    mở lại project — revert step in_progress dang dở
 *
 * `GET /progress` đã có ở T09 (`flags.route.ts`) — không mount lại ở đây.
 * Hợp đồng: docs/api/pipeline-contract.md. `POST /resume` CHƯA có trong bảng endpoint đóng băng của
 * contract — đề xuất contract-change bổ sung (xem báo cáo T13); response ở đây không phụ thuộc schema
 * nào trong `pipeline.dto.ts` (file đó không sửa được ngoài PR contract-change).
 */

import { Request, Response } from "express"
import mongoose from "mongoose"
import { z } from "zod"
import * as spineRepository from "../spine/spine.repository.js"
import * as meter from "./meter.service.js"
import { orderedSteps } from "./step-registry.js"
import type { Spine, SpineRecord } from "../spine/spine.types.js"
import {
  runStep,
  submitAnswer,
  isPipelineErrorCode,
  CALLS_LIMIT,
  REGENERATE_LIMIT_COUNT,
  type Emit
} from "./step-runner.service.js"
import { gate, GateLimitError, type GateInput } from "./gate.service.js"
import { resumeProject } from "./resume.service.js"
import { getProjectById } from "../project/project.service.js"
import { runStepRequestSchema, stepAnswerRequestSchema, gateRequestSchema } from "./pipeline.dto.js"
import { sendError, sendSuccess } from "../../shared/types/api-response.js"
import { catchAsync } from "../../shared/utils/catch-async.js"
import { ApiError } from "../../shared/utils/api-error.js"

const stripRecord = ({ projectId: _projectId, ...spine }: SpineRecord): Spine => spine

const parse = <T extends z.ZodType>(schema: T, input: unknown): z.infer<T> => {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new ApiError(400, z.prettifyError(parsed.error), "VALIDATION_ERROR")
  return parsed.data
}

interface Context {
  projectId: string
  userId: string
}

/** Kiểm quyền sở hữu project trước khi đọc body — người ngoài không dò được DTO qua lỗi 400. */
const authorize = async (req: Request): Promise<Context> => {
  const userId = req.user?.userId
  if (!userId) throw new ApiError(401, "User not authenticated", "UNAUTHORIZED")

  const projectId = req.params.projectId as string
  if (!mongoose.isValidObjectId(projectId)) throw new ApiError(404, "Project not found or unauthorized", "PROJECT_NOT_FOUND")
  await getProjectById(projectId, userId)
  return { projectId, userId }
}

// ─── GET /steps ──────────────────────────────────────────────────

export const getSteps = catchAsync(async (req: Request, res: Response) => {
  const { projectId } = await authorize(req)
  const record = await spineRepository.getOrCreate(projectId)
  const spine = stripRecord(record)

  const steps = await Promise.all(
    orderedSteps(spine).map(async (def) => {
      const state = spine.steps.find((s) => s.id === def.id)
      const counts = state ? await meter.roundCounts(projectId, def.id, state) : { calls_used: 0, regenerate_used: 0 }
      return {
        id: def.id,
        phase: def.phase,
        label_vi: def.label_vi,
        label_en: def.label_en,
        kind: def.kind,
        status: state?.status ?? "pending",
        deterministic: def.deterministic,
        calls_used: counts.calls_used,
        calls_limit: CALLS_LIMIT,
        regenerate_used: counts.regenerate_used,
        regenerate_limit: REGENERATE_LIMIT_COUNT,
        accepted_at: state?.accepted_at ?? null
      }
    })
  )

  return sendSuccess(res, 200, { current_phase: spine.progress.current_phase, current_step: spine.progress.current_step, steps })
})

// ─── POST /steps/:stepId/run (SSE) ─────────────────────────────────

/**
 * SSE: header chỉ mở ở lần `emit` đầu tiên. Lỗi guard-clause (session không pipeline, step không tồn
 * tại/không tới lượt, base_version lệch, CALL_LIMIT đã đầy) ném TRƯỚC lần `emit` đầu ⇒ header chưa gửi ⇒
 * lỗi JSON HTTP thường qua `catchAsync`. Lỗi giữa chừng (draft hỏng, ghi Spine xung đột…) xảy ra SAU khi
 * đã emit ít nhất một sự kiện ⇒ header đã gửi ⇒ phát thành sự kiện SSE `error` rồi đóng luồng.
 */
export const runStepController = catchAsync(async (req: Request, res: Response) => {
  const { projectId, userId } = await authorize(req)
  const stepId = req.params.stepId as string
  const body = parse(runStepRequestSchema, req.body)

  let headersSent = false
  const emit: Emit = (event) => {
    if (!headersSent) {
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8")
      res.setHeader("Cache-Control", "no-cache, no-transform")
      res.setHeader("Connection", "keep-alive")
      res.setHeader("X-Accel-Buffering", "no")
      res.flushHeaders?.()
      headersSent = true
    }
    if (!res.writableEnded) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  }

  // base_version lệch ngay từ đầu ⇒ SPINE_VERSION_CONFLICT trước khi mở SSE (guard-clause).
  const record = await spineRepository.get(projectId)
  if (record && record.spine_version !== body.base_version) {
    throw new ApiError(409, "Tài liệu vừa được thay đổi ở phiên khác. Vui lòng tải lại rồi thử lại.", spineRepository.SPINE_VERSION_CONFLICT)
  }

  try {
    await runStep(projectId, stepId, body.session_id, userId, emit)
  } catch (err) {
    if (!headersSent) throw err
    const code = err instanceof ApiError ? err.code : undefined
    if (code && isPipelineErrorCode(code)) {
      emit({ type: "error", step_id: stepId, code, message: (err as ApiError).message, retryable: code === "SPINE_VERSION_CONFLICT" || code === "INSUFFICIENT_CREDIT" })
    }
    console.error(`[pipeline] /run lỗi giữa chừng cho step ${stepId}:`, err)
  } finally {
    if (headersSent && !res.writableEnded) res.end()
  }
})

// ─── POST /steps/:stepId/answer ────────────────────────────────────

export const answerStep = catchAsync(async (req: Request, res: Response) => {
  const { projectId } = await authorize(req)
  const stepId = req.params.stepId as string
  const body = parse(stepAnswerRequestSchema, req.body)

  const accepted = submitAnswer(projectId, stepId, body.session_id, body.answers)
  if (!accepted) {
    throw new ApiError(409, `Step ${stepId} không đang chờ trả lời câu hỏi`, "STEP_NOT_RUNNABLE")
  }
  return sendSuccess(res, 200, { accepted: true })
})

// ─── POST /steps/:stepId/gate ───────────────────────────────────────

export const gateStep = catchAsync(async (req: Request, res: Response) => {
  const { projectId, userId } = await authorize(req)
  const stepId = req.params.stepId as string
  const body = parse(gateRequestSchema, req.body)

  const input: GateInput = {
    action: body.action,
    base_version: body.base_version,
    ...(body.note === undefined ? {} : { note: body.note }),
    ...(body.function_id === undefined ? {} : { function_id: body.function_id })
  }

  try {
    const result = await gate(projectId, stepId, userId, input)
    return sendSuccess(res, 200, result)
  } catch (err) {
    if (err instanceof GateLimitError) return sendError(res, err.statusCode, err.code, err.message, err.details)
    throw err
  }
})

// ─── POST /resume ───────────────────────────────────────────────────

export const resume = catchAsync(async (req: Request, res: Response) => {
  const { projectId, userId } = await authorize(req)
  const result = await resumeProject(projectId, userId)
  return sendSuccess(res, 200, result)
})
