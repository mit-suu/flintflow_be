/**
 * FLF-294 (BR-03, UC-48, UC-88): ở dự án tạo SRS, sau baseline mỗi lượt áp qua `/changes` là một change request — có mã
 * `CR-nnn`, người yêu cầu và nguồn bắt buộc, ghi thẳng vào bản làm việc khi author xác nhận (CR như commit trên một draft).
 *
 * Mã lấy từ cùng bộ đếm `CrCounter` với CR mode 1 ⇒ một project một dãy số. Mã + người yêu cầu + nguồn đi vào `reason`
 * của lô, nên §I Record of Changes và lịch sử sửa hiện được mà không đổi schema `changes`. Gói phát hành (UC-51/52)
 * gom các lô này về sau — tách ticket riêng.
 */

import { CrCounter } from "../change-request/change-request.model.js"
import { formatCrId, type CrSourceKind } from "../change-request/change-request.constants.js"
import type { ChangeRequestInfo } from "../pipeline/pipeline.dto.js"
import { ApiError } from "../../shared/utils/api-error.js"

export const CR_FIELDS_REQUIRED = "CR_FIELDS_REQUIRED"

/** Nhãn nguồn in vào Record of Changes. */
const SOURCE_LABELS: Record<CrSourceKind, string> = {
  stakeholder_email: "stakeholder email",
  meeting_minutes: "meeting minutes",
  gap_report: "gap report",
  reupload: "re-upload",
  viewer_comment: "Viewer comment",
  verbal: "verbal request",
  chat: "chat"
}

export const assertCrInfo = (info: ChangeRequestInfo | undefined): ChangeRequestInfo => {
  if (!info) {
    throw new ApiError(
      400,
      "Dự án đã có baseline — mọi thay đổi phải là một change request: ghi người yêu cầu và nguồn (email, biên bản, gap report, …).",
      CR_FIELDS_REQUIRED
    )
  }
  return info
}

/** `CR-003 · Ms. Lan · meeting minutes: Biên bản 15/10 — <lý do>` */
export const crReason = (crId: string, info: ChangeRequestInfo, reason: string): string => {
  const ref = info.source.ref?.trim()
  const source = ref ? `${SOURCE_LABELS[info.source.kind]}: ${ref}` : SOURCE_LABELS[info.source.kind]
  return `${crId} · ${info.requester.trim()} · ${source} — ${reason.trim()}`
}

export const nextCrId = async (projectId: string): Promise<string> => {
  const counter = await CrCounter.findOneAndUpdate({ projectId }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: "after" })
  return formatCrId(counter.seq)
}
