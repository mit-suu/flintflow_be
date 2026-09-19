/**
 * C-3 tìm vị trí ảnh hưởng (nút 3.4, UC-50) — tất định, không tốn credit — rồi khoá (3.5).
 * Mode 1 v2 (FLF-186): vị trí là **phần tử Spine** (`spine-location.ts` — đích C-2 + phần tử tham chiếu tới nó,
 * phần tử nhắc mã/tên của đích, phần tử chứa từ khoá), khoá theo path (`lock.service.ts`).
 */

import { stripRecord } from "../import/check.service.js"
import * as spineRepository from "../spine/spine.repository.js"
import type { IChangeRequest } from "./change-request.model.js"
import { assertCrStatus } from "./change-request.service.js"
import { ChangeLocation } from "./change-location.model.js"
import { lockPaths, unlockPaths } from "./lock.service.js"
import { findSpineLocations } from "./spine-location.js"

export { elementPathOf, MAX_LOCATIONS } from "./spine-location.js"

export const formatLocationId = (n: number): string => `L${String(n).padStart(3, "0")}`

/** POST …/impact: tìm lại toàn bộ vị trí (thay lần trước) rồi khoá. */
export const runImpact = async (cr: IChangeRequest): Promise<void> => {
  assertCrStatus(cr, ["impact_review"], "impact_review")
  const record = await spineRepository.get(String(cr.projectId))
  if (!record) throw new Error("Không tìm thấy Spine của project")
  const spine = stripRecord(record)

  const found = findSpineLocations(spine, cr.targets.entity_paths, cr.targets.keywords)
  const previous: string[] = await ChangeLocation.find({ projectId: cr.projectId, cr_id: cr.cr_id }).distinct("path")
  await ChangeLocation.deleteMany({ projectId: cr.projectId, cr_id: cr.cr_id })
  const docs = await ChangeLocation.insertMany(
    found.map((f, i) => ({ projectId: cr.projectId, cr_id: cr.cr_id, location_id: formatLocationId(i + 1), ...f }))
  )
  try {
    await lockPaths(cr.projectId, cr.cr_id, found.map((f) => f.path))
    const kept = new Set(found.map((f) => f.path))
    const dropped = previous.filter((p) => !kept.has(p))
    if (dropped.length) await unlockPaths(cr.projectId, cr.cr_id, dropped)
  } catch (err) {
    await ChangeLocation.deleteMany({ _id: { $in: docs.map((d) => d._id) } })
    throw err
  }
}
