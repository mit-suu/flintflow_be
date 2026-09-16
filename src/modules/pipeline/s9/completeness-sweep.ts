/**
 * completeness-sweep.ts
 * ─────────────────────────────────────────────────────────────────
 * S-9.1 Completeness & Assumption Sweep (Phases §6.4, UC 6.4 + 2.9).
 *
 * Bước **tất định**: không gọi model, không Meter — hết credit vẫn chạy được. Ba việc:
 *   1. Quét lại deterministic check với `atBaseline: true` (bật thêm các luật chỉ chạy ở S-9:
 *      `unconfirmed_assumption`, `section_stale_at_baseline`, `section_awaiting_reaccept`,
 *      `screen_pending_at_baseline`).
 *   2. Gom `assumptions[status=unconfirmed]` **sinh ra trong pha SRS** để UI cho user duyệt lẻ hoặc
 *      duyệt cả lô. Giả định sinh ở pha Brief (`B-*`) đã được quét ở B-2.1, không hỏi lại.
 *   3. Báo glossary có cần chạy lại không: `fixed:5.5` do S-8.1 sở hữu và là section **suy dẫn**, nên
 *      `status()` không bao giờ ra `stale` — phải so mốc accept của S-8.1 với các change đến sau.
 *
 * Điểm sẵn sàng (`readiness`) chỉ để **báo cáo**, không phải điều kiện chốt: baseline chỉ nhìn cờ đỏ
 * (`baseline.service.ts`). Công thức ở `assets/skills/output/srs-completeness-score/SKILL.md`.
 */

import * as flagsService from "../../spine/flags.service.js"
import * as repository from "../../spine/spine.repository.js"
import { changesMakingStale } from "../../spine/reconcile.service.js"
import { computeSectionStates, readiness, type Readiness } from "../../spine/section-status.js"
import { stepsOf } from "../../spine/section-registry.js"
import type { Assumption, Spine, SpineRecord } from "../../spine/spine.types.js"
import { ApiError } from "../../../shared/utils/api-error.js"

/** Section glossary — suy dẫn, do S-8.1 sở hữu. */
export const GLOSSARY_SECTION = "fixed:5.5"

const stripRecord = ({ projectId: _projectId, ...spine }: SpineRecord): Spine => spine

/**
 * Giả định chưa xác nhận **sinh trong pha SRS** (`origin_step_id` bắt đầu bằng `S-`).
 * Giả định của pha Brief đã đi qua Assumption Sweep ở B-2.1 rồi, không hỏi lại ở đây.
 */
export const unconfirmedFromSrs = (spine: Pick<Spine, "assumptions">): Assumption[] =>
  spine.assumptions.filter((a) => a.status === "unconfirmed" && a.origin_step_id.startsWith("S-"))

/**
 * Glossary có lạc hậu không: S-8.1 đã accepted và có change nuôi `fixed:5.5` đến **sau** mốc accept đó.
 * S-8.1 chưa accepted thì chưa nói đến chuyện chạy lại.
 */
export const glossaryNeedsRerun = (spine: Spine, changes: Parameters<typeof changesMakingStale>[1]): boolean => {
  const owner = stepsOf(GLOSSARY_SECTION, spine)[0]
  if (owner === undefined) return false
  if (spine.steps.find((s) => s.id === owner)?.status !== "accepted") return false
  return changesMakingStale(spine, changes, GLOSSARY_SECTION).length > 0
}

export interface SweepResult {
  checked_at_version: number
  /** Cờ đỏ còn mở và CHƯA waive — đúng tập chặn baseline ở S-9.5. */
  red_open: number
  yellow_open: number
  waived: number
  /** Cờ vừa mở thêm trong lượt quét này (thường là luật chỉ chạy ở S-9). */
  opened: string[]
  resolved: string[]
  /** Giả định pha SRS chờ user duyệt lẻ hoặc duyệt lô. */
  unconfirmed_assumptions: Assumption[]
  /** `true` ⇒ nên quay lại S-8.1 (gate revision) trước khi ký. */
  glossary_needs_rerun: boolean
  /** Chỉ báo cáo, không phải điều kiện chốt. */
  readiness: Readiness
}

/** Chạy S-9.1 trên project. Không gọi model. */
export const completenessSweep = async (projectId: string, userId: string): Promise<SweepResult> => {
  const checked = await flagsService.recompute(projectId, { by: userId, atBaseline: true })

  const record = await repository.get(projectId)
  if (!record) throw new ApiError(404, "Không tìm thấy Spine của dự án", repository.SPINE_NOT_FOUND)
  const spine = stripRecord(record)
  const changes = await repository.listChanges(projectId)

  const open = spine.flags.filter((f) => f.resolved_at === null)
  const states = computeSectionStates(spine, changes)

  return {
    checked_at_version: checked.checked_at_version,
    red_open: open.filter((f) => f.level === "red" && !f.waived_by_user).length,
    yellow_open: open.filter((f) => f.level === "yellow" && !f.waived_by_user).length,
    waived: open.filter((f) => f.waived_by_user).length,
    opened: checked.opened,
    resolved: checked.resolved,
    unconfirmed_assumptions: unconfirmedFromSrs(spine),
    glossary_needs_rerun: glossaryNeedsRerun(spine, changes),
    readiness: readiness(spine, changes, states)
  }
}
