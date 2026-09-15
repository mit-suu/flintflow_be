/**
 * pipeline.controller.ts
 * ─────────────────────────────────────────────────────────────────
 * GET  /projects/:projectId/steps                    danh sách step + tiến độ trần
 * POST /projects/:projectId/steps/:stepId/run         chạy step (SSE) — step-runner.service
 * POST /projects/:projectId/steps/:stepId/answer      trả lời Elicit đang chờ (answer_needed)
 * POST /projects/:projectId/steps/:stepId/gate        accept/revision/regenerate/accept_as_is
 *
 * `GET /progress` đã có ở T09 (`flags.route.ts`) — không mount lại ở đây.
 * Hợp đồng: docs/api/pipeline-contract.md.
 *
 * F4 (review T13): `resume.service.ts` (revert step `in_progress` dang dở khi mở lại project) VẪN tồn tại
 * nhưng KHÔNG mount route ở đây — `POST /projects/:id/resume` không có trong bảng endpoint đóng băng của
 * contract (coding-rules §3.8 cấm thêm endpoint ngoài contract). Dùng `resumeProject` ở mức service (T14
 * gọi trực tiếp) cho tới khi có PR `contract-change` bổ sung endpoint.
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
import { getProjectById } from "../project/project.service.js"
import { runStepRequestSchema, stepAnswerRequestSchema, gateRequestSchema, type PipelineErrorCode } from "./pipeline.dto.js"
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
  project: { name: string; domain: string | null }
}

/** Kiểm quyền sở hữu project trước khi đọc body — người ngoài không dò được DTO qua lỗi 400. */
const authorize = async (req: Request): Promise<Context> => {
  const userId = req.user?.userId
  if (!userId) throw new ApiError(401, "User not authenticated", "UNAUTHORIZED")

  const projectId = req.params.projectId as string
  if (!mongoose.isValidObjectId(projectId)) throw new ApiError(404, "Project not found or unauthorized", "PROJECT_NOT_FOUND")
  const project = await getProjectById(projectId, userId)
  return { projectId, userId, project: { name: project.name, domain: project.domain ?? null } }
}

// ─── GET /steps ──────────────────────────────────────────────────

export const getSteps = catchAsync(async (req: Request, res: Response) => {
  const { projectId, project } = await authorize(req)
  // F17: project tạo trước T01 chưa có Spine — tạo rỗng lần đầu đọc, giữ đúng name/domain (như spine.controller.ts).
  const record = await spineRepository.getOrCreate(projectId, { name: project.name, domain: project.domain })
  const spine = stripRecord(record)

  const defs = orderedSteps(spine)
  // F10: một lần roundCountsForSteps thay vì roundCounts cho từng step (N+1, ~2-3×N truy vấn trước đây).
  const counts = await meter.roundCountsForSteps(
    projectId,
    defs.map((def) => {
      const state = spine.steps.find((s) => s.id === def.id)
      return { id: def.id, first_seq: state?.first_seq ?? null }
    })
  )

  const steps = defs.map((def) => {
    const state = spine.steps.find((s) => s.id === def.id)
    const stepCounts = counts.get(def.id) ?? { calls_used: 0, regenerate_used: 0 }
    return {
      id: def.id,
      phase: def.phase,
      label_vi: def.label_vi,
      label_en: def.label_en,
      kind: def.kind,
      status: state?.status ?? "pending",
      deterministic: def.deterministic,
      calls_used: stepCounts.calls_used,
      calls_limit: CALLS_LIMIT,
      regenerate_used: stepCounts.regenerate_used,
      regenerate_limit: REGENERATE_LIMIT_COUNT,
      accepted_at: state?.accepted_at ?? null
    }
  })

  return sendSuccess(res, 200, { current_phase: spine.progress.current_phase, current_step: spine.progress.current_step, steps })
})

// ─── POST /steps/:stepId/run (SSE) ─────────────────────────────────

/** F7: lỗi không thuộc bảng mã pipeline vẫn phải đóng luồng bằng một sự kiện `error` (không được im lặng
 *  đóng) — quy về `VALIDATION_ERROR` nếu là lỗi 400 (đầu vào), còn lại quy về `NOT_IMPLEMENTED` (501, đúng
 *  ngữ nghĩa "nhánh chưa hiện thực"/lỗi không rõ trong bảng contract §0.3). */
const toPipelineErrorCode = (err: unknown): PipelineErrorCode => {
  if (err instanceof ApiError) {
    if (isPipelineErrorCode(err.code)) return err.code
    if (err.statusCode === 400) return "VALIDATION_ERROR"
  }
  return "NOT_IMPLEMENTED"
}

const errorMessageOf = (err: unknown): string => (err instanceof Error ? err.message : "Lỗi không xác định")

/**
 * SSE: header chỉ mở ở lần `emit` đầu tiên. Lỗi guard-clause (session không pipeline, step không tồn
 * tại/không tới lượt, base_version lệch, CALL_LIMIT đã đầy) ném TRƯỚC lần `emit` đầu ⇒ header chưa gửi ⇒
 * lỗi JSON HTTP thường qua `catchAsync`. Lỗi giữa chừng (draft hỏng, ghi Spine xung đột…) xảy ra SAU khi
 * đã emit ít nhất một sự kiện ⇒ header đã gửi ⇒ phát thành sự kiện SSE `error` rồi đóng luồng (F7: luôn
 * phát, kể cả mã lỗi không thuộc bảng).
 *
 * F8: client đóng tab/mất mạng giữa chừng — `req.on("close")` đặt cờ + abort `AbortSignal` truyền vào
 * `runStep`; runner kiểm cờ trước mỗi lượt gọi model và khi đang chờ answer. Sau khi đóng, không `res.write`
 * nữa (dù `runStep` còn đang dọn dẹp).
 */
export const runStepController = catchAsync(async (req: Request, res: Response) => {
  const { projectId, userId } = await authorize(req)
  const stepId = req.params.stepId as string
  const body = parse(runStepRequestSchema, req.body)

  let headersSent = false
  let closed = false
  const abortController = new AbortController()
  req.on("close", () => {
    closed = true
    abortController.abort()
  })

  const emit: Emit = (event) => {
    if (closed) return
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
    await runStep(projectId, stepId, body.session_id, userId, emit, { signal: abortController.signal })
  } catch (err) {
    if (!headersSent) throw err
    if (!closed) {
      const code = toPipelineErrorCode(err)
      emit({ type: "error", step_id: stepId, code, message: errorMessageOf(err), retryable: code === "SPINE_VERSION_CONFLICT" || code === "INSUFFICIENT_CREDIT" })
    }
    console.error(`[pipeline] /run lỗi giữa chừng cho step ${stepId}:`, err)
  } finally {
    if (headersSent && !closed && !res.writableEnded) res.end()
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
