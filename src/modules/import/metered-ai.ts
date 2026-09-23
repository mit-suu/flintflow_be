/**
 * Gọi AI có đo đếm cho mode 1 (Flow 4/5, plan §6 2G) — dùng chung cho I-4, 1.11, C-2, C-4, C-5. FLF-171.
 * - Ví: `executeAiAction` tự giữ credit → trừ sau khi parse đúng schema → hoàn khi lỗi, và tự retry 2 lần
 *   (backoff 1s/3s) cho timeout / rate limit / lỗi provider / sai schema.
 * - Sổ usage (UC-79): `reserveCall` trước khi gọi, `finalizeCall` khi xong, `releaseCall` khi lỗi.
 *   `step_id`: `I-4:<section>`, `I-1.11`, `C-2:<cr>`, `C-4:<cr>`, `C-5:<cr>`.
 * Không ném lỗi AI ra ngoài: trả `{ ok: false, reason }` để caller đặt `paused` (hết credit ⇒ `credits`,
 * lỗi còn lại sau retry ⇒ `resume_later`) và cho người dùng "thử lại / làm sau".
 */

import { executeAiAction } from "../../shared/ai/ai-action.service.js"
import { AiActionError, type ActionType } from "../../shared/ai/ai-action.types.js"
import { finalizeCall, releaseCall, reserveCall } from "../pipeline/meter.service.js"
import { notifyTopUpNeeded } from "./credit-flow.service.js"

export type MeteredPauseReason = "credits" | "resume_later"

export type MeteredResult<T> =
  | { ok: true; data: T; usageId: string; tokens_in: number; tokens_out: number; cost: number }
  | { ok: false; reason: MeteredPauseReason; message: string; usageId: string }

export interface MeteredContext {
  projectId: string
  userId: string
  stepId: string
}

export const isInsufficientCredit = (err: unknown): boolean =>
  err instanceof AiActionError && (err.code === "INSUFFICIENT_CREDIT" || err.statusCode === 402)

export const withMeteredAi = async <T>(
  ctx: MeteredContext,
  actionType: ActionType,
  promptVariables: Record<string, unknown>
): Promise<MeteredResult<T>> => {
  const usageId = await reserveCall(ctx.projectId, ctx.userId, ctx.stepId, actionType)
  try {
    const res = await executeAiAction<T>(actionType, { promptVariables }, ctx.projectId, ctx.userId)
    await finalizeCall(usageId, {
      call_kind: actionType,
      attempt: 1,
      tokens_in: res.tokensUsed.promptTokens,
      tokens_out: res.tokensUsed.completionTokens,
      cost: res.cost,
      logId: res.logId || null
    })
    return { ok: true, data: res.data, usageId, tokens_in: res.tokensUsed.promptTokens, tokens_out: res.tokensUsed.completionTokens, cost: res.cost }
  } catch (err) {
    await releaseCall(usageId)
    const message = err instanceof Error ? err.message : String(err)
    const credits = isInsufficientCredit(err)
    // BPMN 4.2 (mode 1 v3): hết credit ⇒ báo chủ project nạp; nạp xong bước tự chạy tiếp (credit-flow.service)
    if (credits) void notifyTopUpNeeded(ctx.projectId, ctx.stepId)
    return { ok: false, reason: credits ? "credits" : "resume_later", message, usageId }
  }
}
