/**
 * Sửa tay / kết luận tay một vị trí (UC-81, nút 3.9): `manual = true`, AI không đè; đề xuất cần kiểm lại (C-5).
 * FLF-171, plan §6 2E. Sửa sau khi đã đạt (`ready_to_submit`) ⇒ về `verifying` để kiểm lại.
 */

import { latestDocVersion } from "../doc-version/doc-version.service.js"
import { DocBlock } from "../import/doc-block.model.js"
import { Mode1Error } from "../import/mode1.errors.js"
import type { PatchLocationRequest } from "./change-request.dto.js"
import type { IChangeRequest } from "./change-request.model.js"
import { assertCrStatus, transitionCr } from "./change-request.service.js"
import { ChangeLocation } from "./change-location.model.js"

export const patchLocation = async (cr: IChangeRequest, locationId: string, body: PatchLocationRequest): Promise<void> => {
  assertCrStatus(cr, ["impact_review", "proposing", "manual_fix", "ready_to_submit"], "verifying")
  const loc = await ChangeLocation.findOne({ projectId: cr.projectId, cr_id: cr.cr_id, location_id: locationId })
  if (!loc) throw new Mode1Error("CR_LOCATION_NOT_FOUND", `Không có vị trí ${locationId}`)
  const version = await latestDocVersion(cr.projectId)
  const block = await DocBlock.findOne({ projectId: cr.projectId, doc_version: version!.version, block_id: loc.block_id }).lean()
  if (block?.locked_by_cr !== cr.cr_id) {
    throw new Mode1Error("BLOCK_LOCKED", `Block ${loc.block_id} không do ${cr.cr_id} giữ khoá`, {
      locked: block?.locked_by_cr ? [{ block_id: loc.block_id, cr_id: block.locked_by_cr }] : []
    })
  }
  const conclusion = body.conclusion ?? loc.conclusion
  if (!conclusion) throw new Mode1Error("CR_LOCATION_UNCONCLUDED", "Cần chọn kết luận cho vị trí", { location_ids: [locationId] })
  loc.conclusion = conclusion
  if (body.reason !== undefined) loc.reason = body.reason
  loc.proposal = {
    old_text: block.text,
    new_text: conclusion === "edit" ? (body.new_text ?? loc.proposal?.new_text ?? "") : null,
    comment_text: conclusion === "comment" ? (body.comment_text ?? loc.proposal?.comment_text ?? null) : null,
    spine_ops: conclusion === "not_related" ? [] : (loc.proposal?.spine_ops ?? [])
  }
  loc.manual = true
  loc.verify = null
  await loc.save()
  if (cr.status === "ready_to_submit") await transitionCr(cr, "verifying")
}
