/**
 * pipeline-progress.ts
 * ─────────────────────────────────────────────────────────────────
 * Body `progress` cho `GET /projects/:id/progress` và `POST /projects/:id/resume` (contract endpoint 2, 24).
 *
 * `Spine.progress.current_step` là con trỏ ghi lúc `/run` **bắt đầu** một step (`step-runner.service.ts`),
 * không phải lúc gate accept — nên ngay sau khi accept nó vẫn trỏ vào step đã accepted; client tin vào nó
 * rồi gọi `/run` sẽ nhận `STEP_NOT_RUNNABLE`. Ở đây `current_step` được thay bằng step **tới lượt** theo
 * đúng luật `nextStep()` (step đầu tiên chưa accepted, bỏ vòng S-5 của màn `placeholder`); hết step ⇒ `null`.
 *
 * Tính ở tầng pipeline để `modules/spine/section-status.ts` không phụ thuộc `step-registry`. Shape response
 * (`progressResponseSchema`) không đổi; `current_phase` vẫn là giá trị lưu trong Spine.
 */

import { buildProgressReport } from "../spine/section-status.js"
import type { Spine } from "../spine/spine.types.js"
import { nextStep } from "./step-registry.js"

type ProgressChanges = Parameters<typeof buildProgressReport>[1]

export type PipelineProgressReport = ReturnType<typeof buildProgressReport>

export const buildPipelineProgressReport = (spine: Spine, changes: ProgressChanges): PipelineProgressReport => {
  const report = buildProgressReport(spine, changes)
  return { ...report, progress: { ...report.progress, current_step: nextStep(spine)?.id ?? null } }
}
