/**
 * Quyết định của người dùng ở một chỗ (UC-81): **Chấp nhận** đề xuất AI đã soạn, hoặc **Giữ nguyên / Bỏ + lý do**.
 * FLF-375 — nguyên tắc 6 business-flow: người dùng **không sửa tay nội dung**; muốn khác thì gõ hướng sửa để AI soạn lại
 * (`POST …/owner-step-draft`). Không còn nhận giá trị mới / op tự viết / ghi chú tự gõ. Quyết sau khi đã đạt
 * (`ready_to_submit`) ⇒ về `verifying` để kiểm lại.
 */

import { stripRecord } from "../import/check.service.js"
import { Mode1Error } from "../import/mode1.errors.js"
import * as spineRepository from "../spine/spine.repository.js"
import { ApiError } from "../../shared/utils/api-error.js"
import type { PatchLocationRequest } from "./change-request.dto.js"
import type { IChangeRequest } from "./change-request.model.js"
import { assertCrStatus, transitionCr } from "./change-request.service.js"
import { ChangeLocation } from "./change-location.model.js"
import { previewAfter } from "./propose.service.js"
import { snapshotOf } from "./spine-location.js"

export const patchLocation = async (cr: IChangeRequest, locationId: string, body: PatchLocationRequest): Promise<void> => {
  assertCrStatus(cr, ["impact_review", "proposing", "manual_fix", "ready_to_submit"], "verifying")
  const loc = await ChangeLocation.findOne({ projectId: cr.projectId, cr_id: cr.cr_id, location_id: locationId })
  if (!loc) throw new Mode1Error("CR_LOCATION_NOT_FOUND", "Không tìm thấy vị trí cần sửa này")
  const conclusion = body.conclusion ?? loc.conclusion
  if (!conclusion) throw new Mode1Error("CR_LOCATION_UNCONCLUDED", "Cần chọn kết luận cho vị trí", { location_ids: [locationId] })
  // Nguyên tắc 6: "Chấp nhận" chỉ nhận đúng nội dung AI đã soạn — chưa có thì gõ hướng sửa ("Sửa lại"), không gõ thay AI
  if (conclusion === "edit" && !loc.proposal?.spine_ops?.length) {
    throw new Mode1Error("CR_NO_PROPOSAL", "Chỗ này chưa có đề xuất của AI - gõ hướng sửa để AI soạn", { location_ids: [locationId] })
  }
  if (conclusion === "comment" && !loc.proposal?.comment_text) {
    throw new Mode1Error("CR_NO_PROPOSAL", "Chỗ này chưa có ghi chú do AI soạn - gõ hướng sửa để AI soạn", { location_ids: [locationId] })
  }

  const record = await spineRepository.get(String(cr.projectId))
  if (!record) throw new ApiError(404, "Không tìm thấy dữ liệu tài liệu của dự án.", spineRepository.SPINE_NOT_FOUND)
  const spine = stripRecord(record)
  const ops: unknown[] = conclusion === "edit" ? (loc.proposal?.spine_ops ?? []) : []

  loc.conclusion = conclusion
  if (body.reason !== undefined) loc.reason = body.reason
  loc.proposal = {
    proposed_at: loc.proposal?.proposed_at ?? null,
    ...snapshotOf(spine, loc.path),
    new_text: conclusion === "edit" ? previewAfter(spine, loc.path, ops) : null,
    comment_text: conclusion === "comment" ? (loc.proposal?.comment_text ?? null) : null,
    spine_ops: ops,
    assumptions: conclusion === "not_related" ? [] : [...(loc.proposal?.assumptions ?? [])]
  }
  // `manual` = người dùng đã tự quyết chỗ này (giữ nguyên / bỏ) — AI không đè quyết định đó
  loc.manual = true
  loc.verify = null
  // Đã quyết sau màn so sánh 3 cột ("Bỏ yêu cầu") ⇒ hết xung đột
  loc.conflict = null
  await loc.save()
  if (cr.status === "ready_to_submit") await transitionCr(cr, "verifying")
}
