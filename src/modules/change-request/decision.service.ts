/**
 * C-6 duyệt / từ chối từng change group (nút 3.12, UC-52). FLF-171, plan §6 2E.
 * G1: chưa có role ⇒ người tạo tự duyệt. Group bị từ chối mở khoá block ngay. Group cuối được quyết mà có ít nhất
 * một group duyệt ⇒ ghi (C-7) rồi mới lưu quyết định — ghi lỗi thì không lưu gì, gọi lại được.
 * Mọi group bị từ chối ⇒ CR vẫn `in_review`, người dùng chọn sửa lại (revise) hoặc đóng (close).
 */

import mongoose from "mongoose"
import { notify } from "../notification/notification.service.js"
import { Mode1Error } from "../import/mode1.errors.js"
import type { GroupDecisionRequest } from "./change-request.dto.js"
import type { IChangeRequest } from "./change-request.model.js"
import { assertCrStatus, transitionCr } from "./change-request.service.js"
import { ChangeGroup } from "./change-group.model.js"
import { ChangeLocation } from "./change-location.model.js"
import { unlockBlocks } from "./lock.service.js"
import { writeApproved } from "./write.service.js"

export const decideGroup = async (cr: IChangeRequest, userId: string, groupId: string, body: GroupDecisionRequest): Promise<void> => {
  assertCrStatus(cr, ["in_review"], "written")
  const groups = await ChangeGroup.find({ projectId: cr.projectId, cr_id: cr.cr_id })
  const group = groups.find((g) => g.group_id === groupId)
  if (!group) throw new Mode1Error("CR_GROUP_NOT_FOUND", `Không có group ${groupId}`)
  if (group.decision !== "pending") {
    throw new Mode1Error("CR_INVALID_TRANSITION", `Group ${groupId} đã được quyết định`, { status: cr.status, to: "written", allowed: [] })
  }
  const decidedBy = new mongoose.Types.ObjectId(userId)
  const remaining = groups.filter((g) => g.decision === "pending" && g.group_id !== groupId)
  const approvedIds = groups.filter((g) => g.decision === "approved" || (g.group_id === groupId && body.decision === "approved")).flatMap((g) => g.location_ids)

  let written: string | null = null
  if (!remaining.length && approvedIds.length) {
    const approved = await ChangeLocation.find({ projectId: cr.projectId, cr_id: cr.cr_id, location_id: { $in: approvedIds } })
    written = await writeApproved(cr, userId, approved, body.base_version)
  }

  group.decision = body.decision
  group.reason = body.reason ?? null
  group.decided_by = decidedBy
  group.decided_at = new Date()
  await group.save()
  if (body.decision === "rejected") {
    const blockIds = await ChangeLocation.find({ projectId: cr.projectId, cr_id: cr.cr_id, location_id: { $in: group.location_ids } }).distinct("block_id")
    await unlockBlocks(cr.projectId, cr.cr_id, blockIds)
  }
  if (written) {
    cr.result_doc_version = written
    cr.decided_by = decidedBy
    await transitionCr(cr, "written")
  }

  void notify(userId, {
    type: "change_request_decided",
    title: written ? `${cr.cr_id} đã được ghi vào bản ${written}` : `${cr.cr_id}: group ${groupId} ${body.decision === "approved" ? "được duyệt" : "bị từ chối"}`,
    body: written
      ? `Thay đổi "${cr.title}" đã ghi dạng Track Changes vào bản ${written}.`
      : `Group "${group.title}" của "${cr.title}" ${body.decision === "approved" ? "được duyệt" : `bị từ chối: ${body.reason ?? ""}`}.`,
    meta: { cr_id: cr.cr_id, group_id: groupId, decision: body.decision, result_doc_version: written }
  })
}
