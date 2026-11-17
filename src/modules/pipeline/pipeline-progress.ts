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
 * (`progressResponseSchema`) không đổi. FLF-432 (luồng C #2): `current_phase` cũng theo step tới lượt — giá trị lưu
 * trong Spine chỉ ghi lúc một step bắt đầu, nên khi các bước còn lại của giai đoạn đều `skipped` nó đứng ở giai đoạn cũ
 * (`S-4` cạnh `current_step = S-5.1@S02`) và client gọi `/phases/S-4/run` nhận 200 rỗng.
 */

import { buildProgressReport } from "../spine/section-status.js"
import type { Spine } from "../spine/spine.types.js"
import { nextStep } from "./step-registry.js"

type ProgressChanges = Parameters<typeof buildProgressReport>[1]

export type PipelineProgressReport = ReturnType<typeof buildProgressReport>

export const buildPipelineProgressReport = (spine: Spine, changes: ProgressChanges): PipelineProgressReport => {
  const report = buildProgressReport(spine, changes)
  const next = nextStep(spine)
  return { ...report, progress: { ...report.progress, current_phase: next?.phase ?? report.progress.current_phase, current_step: next?.id ?? null } }
}
