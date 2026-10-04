/**
 * resume.service.ts
 * ─────────────────────────────────────────────────────────────────
 * Mở lại project (Phases §3, `assets/skills/action/srs-orchestrator/SKILL.md` §Resume): step đang
 * `in_progress` (đóng tab/mất mạng giữa Draft) ⇒ revert nội dung step đã ghi trong vòng, đặt lại
 * `status = pending`, `first_seq/last_seq = null`, rồi trả `progress` (T09) để FE tiếp tục đúng chỗ.
 * HTTP: `POST /projects/:id/resume` (contract endpoint 24).
 */

import { applyTransaction, CHANGE_RANGE_INVALID, revertChanges } from "../spine/op-engine.js"
import * as spineRepository from "../spine/spine.repository.js"
import type { Change, Spine, SpineRecord } from "../spine/spine.types.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { buildPipelineProgressReport, type PipelineProgressReport } from "./pipeline-progress.js"
import { STEP_NOT_RUNNABLE } from "./step-runner.errors.js"
import { isStepRunning, isAwaitingUser } from "./run-state.service.js"
import { isRegisteredStep } from "./step-registry.js"

const stripRecord = ({ projectId: _projectId, ...spine }: SpineRecord): Spine => spine

export interface ResumeResult {
  /** Id step vừa bị đóng giữa chừng và revert — null nếu không có step nào `in_progress`. */
  reverted_step: string | null
  spine_version: number
  /** `progress.current_step` là step tới lượt (pipeline-progress.ts), không phải con trỏ Spine. */
  progress: PipelineProgressReport
}

/**
 * Sổ sách của runner/gate và dữ liệu suy diễn — không phải nội dung step soạn ra, không revert:
 * - `progress.*`: đếm lượt hỏi của cả giai đoạn, con trỏ — lượt/step sau ghi đè cùng path;
 * - `steps[...]`: status, `first_seq/last_seq` (resume tự đặt lại ở cuối);
 * - `decisions[...]`: câu user đã trả lời vẫn đúng dù nội dung step bị bỏ — không hỏi lại;
 * - `flags[...]`: cờ do recompute sinh (`step_id: null`), tính lại ở lượt chạy sau.
 */
const BOOKKEEPING_PATH = /^(progress\.|steps\[|decisions\[|flags\[)/

/**
 * Nội dung step tự ghi trong vòng hiện tại, để revert. `first_seq..last_seq` là dải ghi lúc tới gate, nhưng nó
 * không còn khớp khi (1) lượt chạy lại sau gate chết giữa chừng — phần nó ghi nằm SAU `last_seq`, và (2) gate
 * revision nới dải qua cả sổ sách của lượt trước và cờ do recompute ghi. Revert cả dải theo seq khi đó đụng
 * path đã bị ghi đè ⇒ 422 `revert_conflict` / `CHANGE_RANGE_INVALID` và project kẹt ở mỗi lần mở (FLF-222).
 *
 * F13 giữ nguyên: nội dung KHÔNG thuộc step (user sửa tay, step khác) xen trong vùng cần revert ⇒ 422, không
 * revert âm thầm đè lên nó.
 */
const stepContentToRevert = async (projectId: string, stepId: string, firstSeq: number, lastSeq: number): Promise<Change[]> => {
  const changes = (await spineRepository.listChanges(projectId, { fromSeq: firstSeq })).filter((c) => !BOOKKEEPING_PATH.test(c.path))
  const own = changes.filter((c) => c.step_id === stepId)
  const end = Math.max(lastSeq, ...own.map((c) => c.seq))
  const foreign = changes.find((c) => c.step_id !== stepId && c.seq <= end)
  if (foreign) {
    throw new ApiError(422, "Không hoàn tác được bước này vì đã có thay đổi khác ghi xen vào sau đó.", CHANGE_RANGE_INVALID, {
      step_id: stepId,
      first_seq: firstSeq,
      last_seq: end,
      foreign_seq: foreign.seq
    })
  }
  return own
}

/** Mở project: revert step `in_progress` dang dở (nếu có) rồi trả tiến độ hiện tại. */
export const resumeProject = async (projectId: string, userId: string): Promise<ResumeResult> => {
  const record = await spineRepository.get(projectId)
  if (!record) throw new ApiError(404, "Không tìm thấy dữ liệu tài liệu của dự án.", spineRepository.SPINE_NOT_FOUND)

  const spine = stripRecord(record)
  // Step đã rời registry (B-0.4, FLF-221) không revert: nội dung nó đã ghi vẫn là dữ liệu của project.
  const inProgress = spine.steps.find((s) => s.status === "in_progress" && isRegisteredStep(s.id))

  let spineVersion = record.spine_version
  let revertedStep: string | null = null

  // Step đang chờ user (chờ trả lời — FLF-222, hoặc chờ duyệt ở cổng chốt) không phải "bỏ dở": mở workspace (reload)
  // mà revert nó thì chính reload xoá mất câu hỏi / nội dung user sắp duyệt.
  if (inProgress && !(await isAwaitingUser(projectId, inProgress.id))) {
    // F2/F4: step đang thật sự chạy dở ở một request khác (khoá `step_runs` còn hiệu lực) — không phải
    // "đóng tab bỏ dở", KHÔNG được revert nội dung đang được ghi.
    if (await isStepRunning(projectId, inProgress.id)) {
      throw new ApiError(409, `Step ${inProgress.id} đang chạy ở một request khác — không thể resume lúc này`, STEP_NOT_RUNNABLE)
    }
    if (inProgress.first_seq !== null && inProgress.last_seq !== null) {
      const content = await stepContentToRevert(projectId, inProgress.id, inProgress.first_seq, inProgress.last_seq)
      if (content.length > 0) {
        const reverted = await revertChanges(projectId, content, { by: userId, step_id: inProgress.id })
        spineVersion = reverted.spine_version
      }
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
  if (!finalRecord) throw new ApiError(404, "Không tìm thấy dữ liệu tài liệu của dự án.", spineRepository.SPINE_NOT_FOUND)
  const finalSpine = stripRecord(finalRecord)
  const changes = await spineRepository.listChanges(projectId)

  return { reverted_step: revertedStep, spine_version: finalSpine.spine_version, progress: buildPipelineProgressReport(finalSpine, changes) }
}
