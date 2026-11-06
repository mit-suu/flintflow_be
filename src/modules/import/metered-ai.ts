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
import { isOverloadError, isTransientError } from "../../shared/ai/retry.service.js"
import { AiActionError, type ActionType } from "../../shared/ai/ai-action.types.js"
import type { LlmImage } from "../../shared/ai/providers/provider.types.js"
import { finalizeCall, releaseCall, reserveCall } from "../pipeline/meter.service.js"
import { notifyTopUpNeeded } from "./credit-flow.service.js"
import { clientErrorMessage } from "../../shared/utils/client-error.js"

export type MeteredPauseReason = "credits" | "resume_later"

/**
 * FLF-360: loại lỗi AI của một lượt gọi (sau khi `executeAiAction` đã tự thử lại + model dự phòng):
 * - `transient` — quá tải / "high demand", 503, 429 không phải hết tiền, timeout, lỗi mạng ⇒ đọc lại sau một lúc;
 * - `credits` — hết credit ⇒ dừng `paused: credits`;
 * - `config` — môi trường không đọc được (thiếu khoá vision, provider không nhận ảnh) hoặc lỗi không tự khỏi (400, 403…)
 *   ⇒ không đọc lại. Ảnh EMF / WMF / file ảnh mất không gọi AI nên không qua hàm này (caller ghi `unsupported`).
 */
export type AiFailureKind = "transient" | "credits" | "config"

/** Mã lỗi cho biết môi trường không đọc được ảnh (không phải lỗi tạm thời). */
export const VISION_UNAVAILABLE: ReadonlySet<string> = new Set(["GEMINI_KEY_MISSING", "AI_PROVIDER_NO_VISION"])

/** Lỗi mạng tầng socket / DNS — `isTransientError` chỉ nhận timeout. */
const NETWORK_CODES: ReadonlySet<string> = new Set(["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "ENETUNREACH", "UND_ERR_SOCKET"])

export const classifyAiFailure = (err: unknown): AiFailureKind => {
  if (isInsufficientCredit(err)) return "credits"
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === "string" && VISION_UNAVAILABLE.has(code)) return "config"
  // Quá tải / chạm hạn mức (503, 429, GEMINI_OVERLOADED / TIMEOUT) — `isOverloadError` đã loại 429 vì hết tiền khỏi nhóm này
  if (isOverloadError(err)) return "transient"
  // Timeout / mạng. Không dùng cả `isTransientError`: nó coi sai schema và mọi lỗi 500 là tạm thời (đáng thử lại trong một
  // lượt gọi), còn đọc lại cả lô sau vài chục giây chỉ đáng khi nhà cung cấp quá tải / mạng chập chờn
  if (typeof code === "string" && NETWORK_CODES.has(code)) return "transient"
  if (isTransientError(err) && !(err instanceof AiActionError)) return "transient"
  const message = err instanceof Error ? err.message.toLowerCase() : ""
  if (message.includes("timeout") || message.includes("fetch failed") || message.includes("socket hang up") || message.includes("network")) return "transient"
  return "config"
}

export type MeteredResult<T> =
  | { ok: true; data: T; usageId: string; tokens_in: number; tokens_out: number; cost: number }
  | {
      ok: false
      reason: MeteredPauseReason
      /** Text thô của lỗi (provider/thư viện) — chỉ để log. */
      message: string
      /** Câu cho user (FLF-247) — dùng khi báo lỗi ra API / ghi vào bản nháp hiện trên UI. */
      userMessage: string
      usageId: string
      code?: string
      /** FLF-360: loại lỗi — `transient` thì caller đọc lại, `config` thì không. */
      kind: AiFailureKind
    }

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
  promptVariables: Record<string, unknown>,
  /** Ảnh kèm prompt (phase 5, `IMPORT_EXTRACT_DIAGRAM`). */
  opts: { images?: LlmImage[] } = {}
): Promise<MeteredResult<T>> => {
  const usageId = await reserveCall(ctx.projectId, ctx.userId, ctx.stepId, actionType)
  try {
    const res = await executeAiAction<T>(actionType, { promptVariables }, ctx.projectId, ctx.userId, opts.images?.length ? { images: opts.images } : {})
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
    console.error(`[metered-ai] ${ctx.stepId} (${actionType}) lỗi:`, message)
    const credits = isInsufficientCredit(err)
    // BPMN 4.2 (mode 1 v3): hết credit ⇒ báo chủ project nạp; nạp xong bước tự chạy tiếp (credit-flow.service)
    if (credits) void notifyTopUpNeeded(ctx.projectId, ctx.stepId)
    const code = err instanceof AiActionError ? err.code : undefined
    return { ok: false, reason: credits ? "credits" : "resume_later", message, userMessage: clientErrorMessage(err), usageId, kind: classifyAiFailure(err), ...(code ? { code } : {}) }
  }
}
