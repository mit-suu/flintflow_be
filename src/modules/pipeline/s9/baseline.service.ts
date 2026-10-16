/**
 * baseline.service.ts
 * ─────────────────────────────────────────────────────────────────
 * S-9.5 Baseline Sign-off (Phases §6.5, srs-spine.md §2.1, §7).
 *
 * Ký baseline KHÔNG phải là "đủ phần trăm section" — điều kiện duy nhất là **không còn cờ đỏ mở chưa
 * waive** trên chính `spine_version` đang ký (audit C7). Vì vậy thứ tự bắt buộc là:
 *   quét lại tất định (`atBaseline`) → đọc lại Spine → kiểm cờ → ghi.
 * `spine_version` đổi giữa lúc quét và lúc ký ⇒ 409, client quét lại. Không có ngưỡng phần trăm nào.
 *
 * Snapshot là **bản sao sâu** của Spine tại thời điểm ký, lưu ở collection `baselines`; bản sạch
 * (`?source=baseline`) render từ snapshot đó, không đọc Spine sống — nên sửa Spine sau khi ký không làm
 * đổi tài liệu đã ký.
 *
 * Không gọi model, không Meter: hết credit vẫn ký được.
 */

import { Baseline } from "../../spine/baseline.model.js"
import * as flagsService from "../../spine/flags.service.js"
import * as repository from "../../spine/spine.repository.js"
import { applyTransaction } from "../../spine/op-engine.js"
import type { Op } from "../../spine/op.types.js"
import type { Baseline as BaselineEntry, Flag, Spine, SpineRecord } from "../../spine/spine.types.js"
import { notify } from "../../notification/notification.service.js"
import { ApiError } from "../../../shared/utils/api-error.js"

/** Hợp đồng §0.3: còn cờ đỏ chưa waive khi ghi baseline. `meta = { flags[] }`. */
export const BASELINE_BLOCKED = "BASELINE_BLOCKED"

/** Step ký baseline — accepted như một phần của chính lượt ký. */
export const SIGN_OFF_STEP = "S-9.5"

const stripRecord = ({ projectId: _projectId, ...spine }: SpineRecord): Spine => spine

/**
 * Cờ đỏ đang chặn: mọi cờ đỏ chưa đóng, **kể cả cờ đã được user waive**. Chọn "giữ nguyên kèm lý do"
 * ghi lại được lý do nhưng không gỡ chặn — cờ đỏ chỉ hết chặn khi nội dung được sửa thật và lượt quét
 * lại đóng nó.
 */
export const blockingFlags = (spine: Pick<Spine, "flags">): Flag[] =>
  spine.flags.filter((f) => f.level === "red" && f.resolved_at === null)

/** Cờ đã waive còn hiệu lực — in vào phụ lục bản ký. Cờ đỏ không bao giờ lọt tới đây vì nó chặn từ trước. */
export const waivedFlags = (spine: Pick<Spine, "flags">): Flag[] =>
  spine.flags.filter((f) => f.waived_by_user && f.resolved_at === null)

export class BaselineBlockedError extends ApiError {
  readonly flags: Flag[]

  constructor(flags: Flag[]) {
    super(422, `Còn ${flags.length} cờ đỏ chưa xử lý — không ghi được baseline`, BASELINE_BLOCKED)
    this.flags = flags
  }
}

/**
 * `v1.0`, `v1.1`, `v1.2`… theo số baseline đã có. Không còn mức `-conditional`: cờ đỏ chặn tuyệt đối
 * nên mọi baseline ký ra đều sạch cờ đỏ. Project có baseline `-conditional` ký trước đây vẫn đánh số
 * tiếp theo `existing.length` nên `(projectId, version)` không đụng unique index.
 */
export const nextBaselineVersion = (existing: readonly BaselineEntry[]): string => `v1.${existing.length}`

export const nextBaselineId = (existing: readonly BaselineEntry[]): string => {
  const max = existing.reduce((acc, b) => {
    const m = /^BL(\d+)$/.exec(b.id)
    return m ? Math.max(acc, Number(m[1])) : acc
  }, 0)
  return `BL${String(max + 1).padStart(3, "0")}`
}

export interface SnapshotBaselineOptions {
  /** `spine_version` của `spine` truyền vào — khoá lạc quan của lô ghi entry. */
  base_version: number
  version: string
  type: BaselineEntry["type"]
  doc_version: string | null
  at?: Date
  by: string
  step_id?: string | null
  /** Op ghi kèm trong cùng lô (vd đánh dấu step S-9.5). */
  extraOps?: Op[]
}

/**
 * Chụp snapshot Spine + ghi entry `baselines[]` — không kiểm cờ, không quét lại (caller tự làm). Tách khỏi
 * `signOff` để mode 1 dùng cho baseline `imported` (0.0) và `release` (1.0…) — FLF-171, P0 báo cáo §3 dòng 6.
 * Lô bị từ chối (409, bất biến) ⇒ xoá snapshot, không để mồ côi.
 */
export const snapshotBaseline = async (
  projectId: string,
  spine: Spine,
  options: SnapshotBaselineOptions
): Promise<{ baseline: BaselineEntry; spine_version: number }> => {
  const at = options.at ?? new Date()
  const waivedCount = waivedFlags(spine).length
  const snapshot = await Baseline.create({
    projectId,
    version: options.version,
    type: options.type,
    doc_version: options.doc_version,
    at,
    checked_at_version: options.base_version,
    waived_count: waivedCount,
    snapshot: structuredClone(spine)
  })
  const entry: BaselineEntry = {
    id: nextBaselineId(spine.baselines),
    version: options.version,
    type: options.type,
    doc_version: options.doc_version,
    at: at.toISOString(),
    snapshot_ref: String(snapshot._id),
    checked_at_version: options.base_version,
    waived_count: waivedCount
  }
  try {
    const applied = await applyTransaction(projectId, {
      base_version: options.base_version,
      ops: [{ op: "add", path: "baselines[]", value: entry, reason: `Baseline ${options.version}` }, ...(options.extraOps ?? [])],
      by: options.by,
      step_id: options.step_id ?? null,
      reason: `Ký baseline ${options.version}`
    })
    return { baseline: entry, spine_version: applied.spine_version }
  } catch (err) {
    await Baseline.deleteOne({ _id: snapshot._id })
    throw err
  }
}

export interface SignOffOptions {
  /** Khoá lạc quan: `spine_version` client đang xem khi bấm ký. */
  base_version: number
}

/**
 * Quét lại tất định ở mức ký rồi đọc lại Spine — bước mở đầu bắt buộc của cả lượt nộp (UC-45) lẫn
 * lượt duyệt (UC-46), vì điều kiện của hai việc là một: cờ đỏ phải bằng 0 trên chính version được xét.
 * Ném 409 khi Spine đổi giữa lúc quét và lúc đọc lại, 404 khi không có Spine.
 */
export const recheckAtBaseline = async (
  projectId: string,
  userId: string,
  baseVersion: number
): Promise<{ spine: Spine; checkedAtVersion: number }> => {
  const before = await repository.get(projectId)
  if (!before) throw new ApiError(404, "Không tìm thấy dữ liệu tài liệu của dự án.", repository.SPINE_NOT_FOUND)
  if (before.spine_version !== baseVersion) {
    throw new ApiError(409, "Tài liệu vừa được thay đổi ở phiên khác. Vui lòng tải lại rồi thử lại.", repository.SPINE_VERSION_CONFLICT)
  }

  const checked = await flagsService.recompute(projectId, { by: userId, atBaseline: true })
  const checkedAtVersion = checked.checked_at_version

  const record = await repository.get(projectId)
  if (!record) throw new ApiError(404, "Không tìm thấy dữ liệu tài liệu của dự án.", repository.SPINE_NOT_FOUND)
  if (record.spine_version !== checkedAtVersion) {
    throw new ApiError(
      409,
      "Tài liệu vừa thay đổi trong lúc kiểm tra trước khi ký. Vui lòng kiểm tra lại rồi ký.",
      repository.SPINE_VERSION_CONFLICT
    )
  }
  return { spine: stripRecord(record), checkedAtVersion }
}

export interface SignOffResult {
  baseline: BaselineEntry
  spine_version: number
  /** Cờ vàng/đỏ đã waive được in vào phụ lục bản ký. */
  waived: Flag[]
}

/**
 * Duyệt và ký baseline (UC-46). Chỉ Lead gọi tới đây — route gắn `requireRole("lead")`. Dùng cho cả
 * hai đường: duyệt bản Analyst đã nộp, và Lead tự duyệt việc của chính mình khi chưa ai nộp.
 * Ném `BaselineBlockedError` (422) khi còn cờ đỏ, `409` khi `spine_version` đổi giữa lúc quét và lúc ghi.
 */
export const signOff = async (projectId: string, userId: string, options: SignOffOptions): Promise<SignOffResult> => {
  const { spine, checkedAtVersion } = await recheckAtBaseline(projectId, userId, options.base_version)

  const blocking = blockingFlags(spine)
  if (blocking.length > 0) throw new BaselineBlockedError(blocking)

  const waived = waivedFlags(spine)
  const version = nextBaselineVersion(spine.baselines)
  const at = new Date()

  // Ghi vào Spine + đánh dấu step S-9.5 accepted trong CÙNG một transaction
  const stepOps: Op[] = []
  const step = spine.steps.find((s) => s.id === SIGN_OFF_STEP)
  if (!step) {
    stepOps.push({
      op: "add",
      path: "steps[]",
      value: { id: SIGN_OFF_STEP, status: "accepted", first_seq: null, last_seq: null, accepted_at: at.toISOString() }
    })
  } else if (step.status !== "accepted") {
    stepOps.push(
      { op: "set", path: `steps[id=${SIGN_OFF_STEP}].status`, value: "accepted" },
      { op: "set", path: `steps[id=${SIGN_OFF_STEP}].accepted_at`, value: at.toISOString() }
    )
  }

  // Bản nộp đã được quyết — xoá trong cùng lô để không còn trạng thái "chờ duyệt" treo sau khi ký.
  const submission = spine.baseline_submission
  if (submission) stepOps.push({ op: "set", path: "baseline_submission", value: null, reason: "Lead đã duyệt baseline" })

  const { baseline: entry, spine_version } = await snapshotBaseline(projectId, spine, {
    base_version: checkedAtVersion,
    version,
    type: "generated",
    doc_version: null,
    at,
    by: userId,
    step_id: SIGN_OFF_STEP,
    extraOps: stepOps
  })
  const applied = { spine_version }

  void notify(userId, {
    type: "baseline_created",
    title: `Đã chốt baseline ${version}`,
    body:
      waived.length > 0
        ? `Tài liệu đã được ký ở mức ${version} với ${waived.length} cờ vàng được bỏ qua có lý do.`
        : `Tài liệu đã được ký ở mức ${version}, không còn cờ đỏ nào.`,
    meta: { version, baseline_id: entry.id, waived_count: waived.length }
  })

  // Người nộp biết kết quả — bỏ qua khi Lead tự duyệt việc của chính mình.
  if (submission && submission.submitted_by !== userId) {
    void notify(submission.submitted_by, {
      type: "baseline_approved",
      title: `Baseline ${version} đã được duyệt`,
      body: `Bản bạn gửi duyệt đã được Lead chấp nhận và khoá ở mức ${version}.`,
      link: `/projects/${projectId}`,
      meta: { projectId, version, baseline_id: entry.id }
    })
  }

  return { baseline: entry, spine_version: applied.spine_version, waived }
}

/** `GET /projects/:id/baselines` — danh sách mốc đã ký, mới nhất cuối (thứ tự ghi). */
export const listBaselines = async (projectId: string): Promise<BaselineEntry[]> => {
  const record = await repository.get(projectId)
  if (!record) throw new ApiError(404, "Không tìm thấy dữ liệu tài liệu của dự án.", repository.SPINE_NOT_FOUND)
  return record.baselines
}
