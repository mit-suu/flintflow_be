/**
 * credit-ack.service.ts
 * ─────────────────────────────────────────────────────────────────
 * FLF-466 P08 — ghi / xác nhận / chặn theo `progress.credit_ack_required` (phần thuần: `credit-ack.ts`).
 *
 * - `recordCreditAck`: gate accept B-2.3 (Approve Brief) và S-4.1 (chốt danh sách màn) ghi lần báo; thêm màn sau S-4.1 được
 *   phát hiện lười ở `enforceCreditAck` (mọi đường thêm màn — chat, CR, op `add screens[]` — đều đi qua Spine nên không
 *   cần móc từng nơi).
 * - `acknowledgeCredit`: `POST /:projectId/run-estimate/ack` — user đồng ý ⇒ gỡ chặn, ghi màn đã xác nhận. Không đồng ý ⇒ không gọi gì,
 *   step giữ nguyên bị chặn, tiến độ giữ.
 * - `enforceCreditAck`: step runner gọi trước khi chạy — 409 `CREDIT_ACK_REQUIRED`.
 */

import { applyTransaction } from "../spine/op-engine.js"
import * as spineRepository from "../spine/spine.repository.js"
import type { TemplateLoopHint } from "../spine/section-status.js"
import { TemplateProfile } from "../import/template-profile.model.js"
import { Project } from "../project/project.model.js"
import type { CreditAckRequired, CreditAckScope, Spine, SpineRecord } from "../spine/spine.types.js"
import type { Op } from "../spine/op.types.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { APPROVE_BRIEF_STEP, CREDIT_ACK_REQUIRED, CREDIT_ACK_REQUIRED_MESSAGE, SCREENS_LOCK_STEP, creditAckBlocks, referenceAckDue, uncoveredScreens } from "./credit-ack.js"
import { loadRunEstimateCosts, planRunEstimate } from "./run-estimate.js"

export const NO_CREDIT_ACK_PENDING = "NO_CREDIT_ACK_PENDING"

const stripRecord = ({ projectId: _projectId, ...spine }: SpineRecord): Spine => spine

/** Màn thuộc phần màn của lần báo (chưa placeholder / signed_off) — danh sách ghi vào `screens` của lần báo. */
const screensToQuote = (spine: Spine): string[] => spine.screens.filter((s) => s.detail_status !== "placeholder" && s.detail_status !== "signed_off").map((s) => s.id)

/** Dựng lần báo cho `scope` từ Spine hiện tại (credit tính ngay: after_brief = step cố định từ S-2; màn = vòng màn). */
export const buildCreditAck = async (
  spine: Spine,
  scope: CreditAckScope,
  screens?: string[],
  templateProfile?: TemplateLoopHint | null
): Promise<CreditAckRequired> => {
  const costs = await loadRunEstimateCosts()
  const quoted = scope === "after_brief" ? undefined : (screens ?? (scope === "screens_locked" ? screensToQuote(spine) : uncoveredScreens(spine)))
  const probe: Spine = { ...spine, progress: { ...spine.progress, credit_ack_required: null } }
  const plan = planRunEstimate(probe, { scope: "all", scope_kind: scope, screens: scope === "screens_added" ? quoted : undefined }, costs, templateProfile)
  return { scope, credits: plan.credits_total, created_at: new Date().toISOString(), ...(quoted ? { screens: quoted } : {}) }
}

/**
 * Ghi lần báo sau khi gate chấp nhận `stepId`. Chỉ B-2.3 và S-4.1 sinh lần báo; step khác không làm gì. Trả version mới
 * (hoặc `null` khi không ghi).
 */
export const recordCreditAckAfterAccept = async (projectId: string, stepId: string, userId: string): Promise<number | null> => {
  const scope: CreditAckScope | null = stepId === APPROVE_BRIEF_STEP ? "after_brief" : stepId === SCREENS_LOCK_STEP ? "screens_locked" : null
  if (!scope) return null
  const [record, templateProfile] = await Promise.all([
    spineRepository.get(projectId),
    TemplateProfile.db.readyState === 1 ? TemplateProfile.findOne({ projectId }).select("step_plan").lean() : Promise.resolve(null)
  ])
  if (!record) return null
  const spine = stripRecord(record)
  const ack = await buildCreditAck(spine, scope, undefined, templateProfile)
  const result = await applyTransaction(projectId, {
    base_version: record.spine_version,
    ops: [{ op: "set", path: "progress.credit_ack_required", value: ack }],
    by: userId,
    step_id: stepId,
    reason: `credit: báo ${scope}`
  })
  return result.spine_version
}

export interface AckResult {
  scope: CreditAckScope
  credits: number
  spine_version: number
}

/** Người dùng xác nhận lần báo đang chờ. Không có ⇒ 409 `NO_CREDIT_ACK_PENDING`. */
export const acknowledgeCredit = async (projectId: string, userId: string): Promise<AckResult> => {
  const record = await spineRepository.get(projectId)
  if (!record) throw new ApiError(404, "Không tìm thấy dữ liệu tài liệu của dự án.", spineRepository.SPINE_NOT_FOUND)
  const ack = record.progress.credit_ack_required
  if (!ack) throw new ApiError(409, "Không có thông báo credit nào đang chờ xác nhận.", NO_CREDIT_ACK_PENDING)
  // FLF-458: xác nhận đọc tài liệu tham khảo ở B-0 ⇒ đọc ngay (lúc này mới trừ credit). Hết credit ⇒ 402, giữ lần báo, tài liệu còn `pending`.
  if (ack.scope === "reference_documents") {
    const { summarizePendingAtStart } = await import("../project/project-document.service.js")
    await summarizePendingAtStart(projectId, userId)
  }
  const ops: Op[] = [{ op: "set", path: "progress.credit_ack_required", value: null }]
  if (ack.screens) {
    const acked = [...new Set([...(record.progress.credit_acked_screens ?? []), ...ack.screens])]
    ops.push({ op: "set", path: "progress.credit_acked_screens", value: acked })
  } else if (ack.scope === "after_brief" && !record.progress.credit_acked_screens) {
    // Chế độ 3/4: nếu S-4.1 đã chốt sẵn từ file import ⇒ màn có sẵn đã xong vòng S-5 không tính thành màn mới thêm
    const s41Accepted = record.steps.some((s) => s.id === SCREENS_LOCK_STEP && s.status === "accepted")
    const preAcked = s41Accepted
      ? record.screens
          .filter((s) => {
            const loopSteps = record.steps.filter((st) => st.id.endsWith(`@${s.id}`))
            return loopSteps.length > 0 && loopSteps.every((st) => st.status === "accepted" || st.status === "skipped")
          })
          .map((s) => s.id)
      : []
    ops.push({ op: "set", path: "progress.credit_acked_screens", value: preAcked })
  }
  const result = await applyTransaction(projectId, {
    base_version: record.spine_version,
    ops,
    by: userId,
    step_id: null,
    reason: `credit: xác nhận ${ack.scope}`
  })
  return { scope: ack.scope, credits: ack.credits, spine_version: result.spine_version }
}

/**
 * FLF-458: lần báo `reference_documents` — dự án tạo không có SRS mà có tài liệu tham khảo đang chờ đọc, step đầu của B-0 sắp
 * chạy. Trả `null` khi không tới lượt báo (có SRS, B-0 đã bắt đầu, không có tài liệu chờ).
 */
const referenceDocumentsAck = async (projectId: string, spine: Spine, stepId: string): Promise<CreditAckRequired | null> => {
  if (stepId.split(".")[0] !== "B-0") return null
  const { pendingSummaryCredits } = await import("../project/project-document.service.js")
  const { documents, credits } = await pendingSummaryCredits(projectId)
  if (documents === 0) return null
  const project = await Project.findById(projectId).select("mode").lean()
  if (!referenceAckDue(spine, stepId, project?.mode, documents)) return null
  return { scope: "reference_documents", credits, documents, created_at: new Date().toISOString() }
}

/**
 * Chặn step thuộc phạm vi lần báo chưa xác nhận. Phát hiện lười lần báo `screens_added` (màn thêm sau S-4.1 chưa báo). Ném
 * 409 `CREDIT_ACK_REQUIRED` kèm lần báo trong `details`.
 */
export const enforceCreditAck = async (projectId: string, spine: Spine, stepId: string, userId: string): Promise<void> => {
  let ack = spine.progress.credit_ack_required ?? null
  if (!ack) {
    const fresh = uncoveredScreens(spine)
    // Chỉ chặn khi chính step này thuộc một màn chưa được báo
    const loop = stepId.includes("@") ? stepId.slice(stepId.indexOf("@") + 1) : null
    const screensDue = fresh.length > 0 && loop !== null && fresh.includes(loop)
    const next = screensDue ? await buildCreditAck(spine, "screens_added", fresh) : await referenceDocumentsAck(projectId, spine, stepId)
    if (!next) return
    ack = next
    const record = await spineRepository.get(projectId)
    if (record) {
      await applyTransaction(projectId, {
        base_version: record.spine_version,
        ops: [{ op: "set", path: "progress.credit_ack_required", value: ack }],
        by: userId,
        step_id: null,
        reason: `credit: báo ${ack.scope}`
      })
    }
  }
  if (creditAckBlocks(ack, stepId)) throw new ApiError(409, CREDIT_ACK_REQUIRED_MESSAGE, CREDIT_ACK_REQUIRED, { ack_required: ack, step_id: stepId })
}
