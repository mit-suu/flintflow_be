/**
 * Gom vị trí thành change group để duyệt (nút 3.11–3.12). FLF-171, plan §6 2E. Gọi lại sau C-4 và trước khi nộp
 * (người dùng có thể đổi kết luận tay), quyết định cũ bị xoá vì group chỉ được quyết sau khi nộp.
 * Mode 1 v2 (FLF-186): gom theo section của phần tử Spine (`section_id` của vị trí).
 */

import { stripRecord } from "../import/check.service.js"
import { loadLayout, titleOfSection } from "../import/gap-report.service.js"
import * as spineRepository from "../spine/spine.repository.js"
import type { IChangeRequest } from "./change-request.model.js"
import { ChangeGroup } from "./change-group.model.js"
import { ChangeLocation, type IChangeLocation } from "./change-location.model.js"

/** Gom vị trí có sửa/ghi chú thành group theo section; `not_related` không vào group. */
export const regroup = async (cr: IChangeRequest): Promise<void> => {
  const [record, layout] = await Promise.all([spineRepository.get(String(cr.projectId)), loadLayout(String(cr.projectId))])
  const spine = stripRecord(record!)
  const locations = await ChangeLocation.find({ projectId: cr.projectId, cr_id: cr.cr_id }).sort({ location_id: 1 })
  const bySection = new Map<string, IChangeLocation[]>()
  for (const l of locations) {
    if (l.conclusion !== "edit" && l.conclusion !== "comment") continue
    const key = l.section_id || "misc"
    bySection.set(key, [...(bySection.get(key) ?? []), l])
  }
  await ChangeGroup.deleteMany({ projectId: cr.projectId, cr_id: cr.cr_id })
  let n = 0
  const groups = [...bySection].map(([section, locs]) => ({
    projectId: cr.projectId,
    cr_id: cr.cr_id,
    group_id: `G${String(++n).padStart(2, "0")}`,
    title: section === "misc" ? "Khác" : titleOfSection(spine, section, layout),
    location_ids: locs.map((l) => l.location_id),
    decision: "pending"
  }))
  if (groups.length) await ChangeGroup.insertMany(groups)
  const groupOf = new Map(groups.flatMap((g) => g.location_ids.map((id) => [id, g.group_id] as const)))
  await Promise.all(
    locations.map((l) => ChangeLocation.updateOne({ _id: l._id }, { $set: { group_id: groupOf.get(l.location_id) ?? null } }))
  )
}
