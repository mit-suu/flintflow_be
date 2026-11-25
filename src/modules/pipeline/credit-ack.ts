/**
 * credit-ack.ts
 * ─────────────────────────────────────────────────────────────────
 * FLF-466 P08 — phần THUẦN của "xác nhận credit trước khi chạy hàng loạt" (business-flow §2 dòng 180, §1.1 dòng 69-73).
 *
 * Ba lần báo (`CreditAckScope`):
 *   - `after_brief`    sau Approve Brief (B-2.3): credit chính xác step cố định từ S-2 + ước tính phần màn;
 *   - `screens_locked` S-4.1 chấp nhận danh sách màn: credit chính xác phần vòng màn;
 *   - `screens_added`  thêm màn sau S-4.1 (chat, CR): credit phần màn thêm.
 * Xác nhận nằm ở server (`progress.credit_ack_required`): step thuộc phạm vi bị chặn 409 `CREDIT_ACK_REQUIRED` tới khi
 * `POST /run-estimate/ack`; không đồng ý ⇒ không ack, tiến độ giữ nguyên. Reload trang vẫn thấy vì state nằm trong Spine.
 */

import type { CreditAckRequired, Spine } from "../spine/spine.types.js"
import { PHASES, parseStepId } from "./step-registry.js"

export const CREDIT_ACK_REQUIRED = "CREDIT_ACK_REQUIRED"
export const CREDIT_ACK_REQUIRED_MESSAGE = "Cần xác nhận credit trước khi chạy tiếp."

/** Bước chốt Brief (Approve Brief) và chốt danh sách màn — hai mốc sinh lần báo. */
export const APPROVE_BRIEF_STEP = "B-2.3"
export const SCREENS_LOCK_STEP = "S-4.1"

const indexOfPhase = (phase: string): number => (PHASES as readonly string[]).indexOf(phase)
const FIRST_SRS_PHASE_INDEX = indexOfPhase("S-2")

/** Step `stepId` có thuộc phạm vi của lần báo `ack` không (⇒ bị chặn tới khi xác nhận). */
export const creditAckBlocks = (ack: CreditAckRequired | null | undefined, stepId: string): boolean => {
  if (!ack) return false
  const { base, loop } = parseStepId(stepId)
  const phase = base.replace(/\.\d+$/, "")
  switch (ack.scope) {
    case "after_brief":
      return indexOfPhase(phase) >= FIRST_SRS_PHASE_INDEX
    case "screens_locked":
      return loop !== null
    case "screens_added":
      return loop !== null && (ack.screens ?? []).includes(loop)
  }
}

const stepAccepted = (spine: Pick<Spine, "steps">, id: string): boolean => spine.steps.some((s) => s.id === id && s.status === "accepted")

/**
 * Màn đã có sau S-4.1 mà chưa được báo credit (không nằm trong `credit_acked_screens`, vòng S-5 của nó còn việc, không phải
 * placeholder). Dự án cũ (chưa có `credit_acked_screens`) hoặc chưa chốt S-4.1 ⇒ không có.
 */
export const uncoveredScreens = (spine: Pick<Spine, "steps" | "screens" | "progress">): string[] => {
  const acked = spine.progress.credit_acked_screens
  if (!acked || !stepAccepted(spine, SCREENS_LOCK_STEP)) return []
  const known = new Set(acked)
  return spine.screens
    .filter((s) => {
      if (s.detail_status === "placeholder" || s.detail_status === "signed_off" || known.has(s.id)) return false
      const loopSteps = spine.steps.filter((st) => st.id.endsWith(`@${s.id}`))
      if (loopSteps.length > 0 && loopSteps.every((st) => st.status === "accepted" || st.status === "skipped")) return false
      return true
    })
    .map((s) => s.id)
}
