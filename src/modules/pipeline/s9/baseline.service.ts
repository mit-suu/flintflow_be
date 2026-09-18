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

/** Cờ đỏ đang chặn: chưa đóng và chưa được user waive. */
export const blockingFlags = (spine: Pick<Spine, "flags">): Flag[] =>
  spine.flags.filter((f) => f.level === "red" && f.resolved_at === null && !f.waived_by_user)

/** Cờ đã waive còn hiệu lực — quyết định baseline có `-conditional` không. */
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
 * `v1.0`, `v1.1`, `v1.2`… theo số baseline đã có. Có waive còn hiệu lực thì thêm `-conditional`
 * (srs-spine.md §7) — đánh số theo thứ tự chứ không theo "sạch/không sạch", nên `(projectId, version)`
 * không bao giờ đụng unique index dù lần trước là conditional.
 */
export const nextBaselineVersion = (existing: readonly BaselineEntry[], waivedCount: number): string =>
  `v1.${existing.length}${waivedCount > 0 ? "-conditional" : ""}`

const nextBaselineId = (existing: readonly BaselineEntry[]): string => {
  const max = existing.reduce((acc, b) => {
    const m = /^BL(\d+)$/.exec(b.id)
    return m ? Math.max(acc, Number(m[1])) : acc
  }, 0)
  return `BL${String(max + 1).padStart(3, "0")}`
}

export interface SignOffOptions {
  /** Khoá lạc quan: `spine_version` client đang xem khi bấm ký. */
  base_version: number
}

export interface SignOffResult {
  baseline: BaselineEntry
  spine_version: number
  /** Cờ vàng/đỏ đã waive được in vào phụ lục bản ký. */
  waived: Flag[]
}

/**
 * Ký baseline. Ném `BaselineBlockedError` (422) khi còn cờ đỏ chưa waive, `409` khi `spine_version`
 * đổi giữa lúc quét và lúc ghi.
 */
export const signOff = async (projectId: string, userId: string, options: SignOffOptions): Promise<SignOffResult> => {
  const before = await repository.get(projectId)
  if (!before) throw new ApiError(404, "Không tìm thấy Spine của dự án", repository.SPINE_NOT_FOUND)
  if (before.spine_version !== options.base_version) {
    throw new ApiError(409, "Tài liệu vừa được thay đổi ở phiên khác. Vui lòng tải lại rồi thử lại.", repository.SPINE_VERSION_CONFLICT)
  }

  // 1. Quét lại tất định NGAY TRƯỚC khi ký, có cả luật chỉ chạy ở S-9
  const checked = await flagsService.recompute(projectId, { by: userId, atBaseline: true })
  const checkedAtVersion = checked.checked_at_version

  // 2. Đọc lại Spine sau lượt quét — cờ vừa mở/đóng phải được tính vào
  const record = await repository.get(projectId)
  if (!record) throw new ApiError(404, "Không tìm thấy Spine của dự án", repository.SPINE_NOT_FOUND)
  if (record.spine_version !== checkedAtVersion) {
    throw new ApiError(
      409,
      "Spine đổi trong lúc quét trước khi ký. Vui lòng quét lại rồi ký.",
      repository.SPINE_VERSION_CONFLICT
    )
  }

  const spine = stripRecord(record)
  const blocking = blockingFlags(spine)
  if (blocking.length > 0) throw new BaselineBlockedError(blocking)

  const waived = waivedFlags(spine)
  const version = nextBaselineVersion(spine.baselines, waived.length)
  const at = new Date()

  // 3. Snapshot: bản sao sâu của Spine tại version vừa quét
  const snapshot = await Baseline.create({
    projectId,
    version,
    type: "generated",
    doc_version: null,
    at,
    checked_at_version: checkedAtVersion,
    waived_count: waived.length,
    snapshot: structuredClone(spine)
  })

  const entry: BaselineEntry = {
    id: nextBaselineId(spine.baselines),
    version,
    type: "generated",
    doc_version: null,
    at: at.toISOString(),
    snapshot_ref: String(snapshot._id),
    checked_at_version: checkedAtVersion,
    waived_count: waived.length
  }

  // 4. Ghi vào Spine + đánh dấu step S-9.5 accepted trong CÙNG một transaction
  const ops: Op[] = [{ op: "add", path: "baselines[]", value: entry, reason: `Baseline ${version}` }]
  const step = spine.steps.find((s) => s.id === SIGN_OFF_STEP)
  if (!step) {
    ops.push({
      op: "add",
      path: "steps[]",
      value: { id: SIGN_OFF_STEP, status: "accepted", first_seq: null, last_seq: null, accepted_at: at.toISOString() }
    })
  } else if (step.status !== "accepted") {
    ops.push(
      { op: "set", path: `steps[id=${SIGN_OFF_STEP}].status`, value: "accepted" },
      { op: "set", path: `steps[id=${SIGN_OFF_STEP}].accepted_at`, value: at.toISOString() }
    )
  }

  let applied
  try {
    applied = await applyTransaction(projectId, {
      base_version: checkedAtVersion,
      ops,
      by: userId,
      step_id: SIGN_OFF_STEP,
      reason: `Ký baseline ${version}`
    })
  } catch (err) {
    // Không để lại snapshot mồ côi khi lô bị từ chối (409 hai tab, bất biến…)
    await Baseline.deleteOne({ _id: snapshot._id })
    throw err
  }

  void notify(userId, {
    type: "baseline_created",
    title: `Đã chốt baseline ${version}`,
    body:
      waived.length > 0
        ? `Tài liệu đã được ký ở mức ${version} với ${waived.length} cờ được bỏ qua có lý do.`
        : `Tài liệu đã được ký ở mức ${version}, không còn cờ đỏ nào.`,
    meta: { version, baseline_id: entry.id, waived_count: waived.length }
  })

  return { baseline: entry, spine_version: applied.spine_version, waived }
}

/** `GET /projects/:id/baselines` — danh sách mốc đã ký, mới nhất cuối (thứ tự ghi). */
export const listBaselines = async (projectId: string): Promise<BaselineEntry[]> => {
  const record = await repository.get(projectId)
  if (!record) throw new ApiError(404, "Không tìm thấy Spine của dự án", repository.SPINE_NOT_FOUND)
  return record.baselines
}
