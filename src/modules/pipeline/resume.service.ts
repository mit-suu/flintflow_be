/**
 * resume.service.ts
 * ─────────────────────────────────────────────────────────────────
 * Mở lại project (Phases §3, `assets/skills/action/srs-orchestrator/SKILL.md` §Resume): step đang
 * `in_progress` (đóng tab/mất mạng giữa Draft) ⇒ revert dải `changes[first_seq..last_seq]` bằng
 * `revertRange` (T08), đặt lại `status = pending`, `first_seq/last_seq = null`, rồi trả `progress` (T09)
 * để FE tiếp tục đúng chỗ.
 */

import { applyTransaction, revertRange } from "../spine/op-engine.js"
import * as spineRepository from "../spine/spine.repository.js"
import { buildProgressReport } from "../spine/section-status.js"
import type { Spine, SpineRecord } from "../spine/spine.types.js"
import { ApiError } from "../../shared/utils/api-error.js"

const stripRecord = ({ projectId: _projectId, ...spine }: SpineRecord): Spine => spine

export interface ResumeResult {
  /** Id step vừa bị đóng giữa chừng và revert — null nếu không có step nào `in_progress`. */
  reverted_step: string | null
  spine_version: number
  progress: ReturnType<typeof buildProgressReport>
}

/** Mở project: revert step `in_progress` dang dở (nếu có) rồi trả tiến độ hiện tại. */
export const resumeProject = async (projectId: string, userId: string): Promise<ResumeResult> => {
  const record = await spineRepository.get(projectId)
  if (!record) throw new ApiError(404, "Không tìm thấy Spine của dự án", spineRepository.SPINE_NOT_FOUND)

  const spine = stripRecord(record)
  const inProgress = spine.steps.find((s) => s.status === "in_progress")

  let spineVersion = record.spine_version
  let revertedStep: string | null = null

  if (inProgress) {
    if (inProgress.first_seq !== null && inProgress.last_seq !== null) {
      const reverted = await revertRange(projectId, inProgress.first_seq, inProgress.last_seq, {
        by: userId,
        step_id: inProgress.id
      })
      spineVersion = reverted.spine_version
    }
    const applied = await applyTransaction(projectId, {
      base_version: spineVersion,
      ops: [
        { op: "set", path: `steps[id=${inProgress.id}].status`, value: "pending" },
        { op: "set", path: `steps[id=${inProgress.id}].first_seq`, value: null },
        { op: "set", path: `steps[id=${inProgress.id}].last_seq`, value: null }
      ],
      by: userId,
      step_id: inProgress.id,
      reason: "resume: đóng giữa chừng, đưa step về pending"
    })
    spineVersion = applied.spine_version
    revertedStep = inProgress.id
  }

  const finalRecord = await spineRepository.get(projectId)
  if (!finalRecord) throw new ApiError(404, "Không tìm thấy Spine của dự án", spineRepository.SPINE_NOT_FOUND)
  const finalSpine = stripRecord(finalRecord)
  const changes = await spineRepository.listChanges(projectId)

  return { reverted_step: revertedStep, spine_version: finalSpine.spine_version, progress: buildProgressReport(finalSpine, changes) }
}
