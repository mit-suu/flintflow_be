/**
 * resume.service.ts
 * ─────────────────────────────────────────────────────────────────
 * Mở lại project (Phases §3, `assets/skills/action/srs-orchestrator/SKILL.md` §Resume): step đang
 * `in_progress` (đóng tab/mất mạng giữa Draft) ⇒ revert dải `changes[first_seq..last_seq]` bằng
 * `revertRange` (T08), đặt lại `status = pending`, `first_seq/last_seq = null`, rồi trả `progress` (T09)
 * để FE tiếp tục đúng chỗ. HTTP: `POST /projects/:id/resume` (contract endpoint 24).
 */

import { applyTransaction, revertRange } from "../spine/op-engine.js"
import * as spineRepository from "../spine/spine.repository.js"
import type { Spine, SpineRecord } from "../spine/spine.types.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { buildPipelineProgressReport, type PipelineProgressReport } from "./pipeline-progress.js"
import { assertRangeOwnedByStep } from "./step-runner.service.js"
import { STEP_NOT_RUNNABLE } from "./step-runner.errors.js"
import { isStepRunning } from "./run-state.service.js"

const stripRecord = ({ projectId: _projectId, ...spine }: SpineRecord): Spine => spine

export interface ResumeResult {
  /** Id step vừa bị đóng giữa chừng và revert — null nếu không có step nào `in_progress`. */
  reverted_step: string | null
  spine_version: number
  /** `progress.current_step` là step tới lượt (pipeline-progress.ts), không phải con trỏ Spine. */
  progress: PipelineProgressReport
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
    // F2/F4: step đang thật sự chạy dở ở một request khác (khoá `step_runs` còn hiệu lực) — không phải
    // "đóng tab bỏ dở", KHÔNG được revert nội dung đang được ghi.
    if (await isStepRunning(projectId, inProgress.id)) {
      throw new ApiError(409, `Step ${inProgress.id} đang chạy ở một request khác — không thể resume lúc này`, STEP_NOT_RUNNABLE)
    }
    if (inProgress.first_seq !== null && inProgress.last_seq !== null) {
      // F13: không revert âm thầm nếu dải seq của step bị lẫn change không thuộc step (user sửa tay).
      await assertRangeOwnedByStep(projectId, inProgress.id, inProgress.first_seq, inProgress.last_seq)
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

  return { reverted_step: revertedStep, spine_version: finalSpine.spine_version, progress: buildPipelineProgressReport(finalSpine, changes) }
}
