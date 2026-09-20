/**
 * Sửa tay / kết luận tay một vị trí (UC-81, nút 3.9): `manual = true`, AI không đè; đề xuất cần kiểm lại (C-5).
 * FLF-171, plan §6 2E. Sửa sau khi đã đạt (`ready_to_submit`) ⇒ về `verifying` để kiểm lại.
 * Mode 1 v2 (FLF-186): vị trí là phần tử Spine — sửa bằng `new_value` (giá trị mới của cả phần tử ⇒ op `set`) hoặc
 * `spine_ops` tự viết; phần tử phải do CR này giữ khoá.
 */

import { stripRecord } from "../import/check.service.js"
import { Mode1Error } from "../import/mode1.errors.js"
import * as spineRepository from "../spine/spine.repository.js"
import type { PatchLocationRequest } from "./change-request.dto.js"
import type { IChangeRequest } from "./change-request.model.js"
import { assertCrStatus, transitionCr } from "./change-request.service.js"
import { ChangeLocation } from "./change-location.model.js"
import { locksOf, pathLocked } from "./lock.service.js"
import { previewAfter } from "./propose.service.js"
import { elementValue, valueText } from "./spine-location.js"

export const patchLocation = async (cr: IChangeRequest, locationId: string, body: PatchLocationRequest): Promise<void> => {
  assertCrStatus(cr, ["impact_review", "proposing", "manual_fix", "ready_to_submit"], "verifying")
  const loc = await ChangeLocation.findOne({ projectId: cr.projectId, cr_id: cr.cr_id, location_id: locationId })
  if (!loc) throw new Mode1Error("CR_LOCATION_NOT_FOUND", `Không có vị trí ${locationId}`)
  const holder = (await locksOf(cr.projectId, [loc.path])).get(loc.path)
  if (holder !== cr.cr_id) throw pathLocked(holder ? [{ path: loc.path, cr_id: holder }] : [])
  const conclusion = body.conclusion ?? loc.conclusion
  if (!conclusion) throw new Mode1Error("CR_LOCATION_UNCONCLUDED", "Cần chọn kết luận cho vị trí", { location_ids: [locationId] })

  const record = await spineRepository.get(String(cr.projectId))
  if (!record) throw new Error("Không tìm thấy Spine của project")
  const spine = stripRecord(record)
  const ops: unknown[] =
    conclusion !== "edit"
      ? []
      : (body.spine_ops ?? (body.new_value !== undefined ? [{ op: "set", path: loc.path, value: body.new_value }] : (loc.proposal?.spine_ops ?? [])))

  loc.conclusion = conclusion
  if (body.reason !== undefined) loc.reason = body.reason
  loc.proposal = {
    old_text: valueText(elementValue(spine, loc.path)),
    new_text: conclusion === "edit" ? previewAfter(spine, loc.path, ops) : null,
    comment_text: conclusion === "comment" ? (body.comment_text ?? loc.proposal?.comment_text ?? null) : null,
    spine_ops: ops
  }
  loc.manual = true
  loc.verify = null
  await loc.save()
  if (cr.status === "ready_to_submit") await transitionCr(cr, "verifying")
}
