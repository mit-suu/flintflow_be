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
import { emptySectionTargets, findSpineLocations } from "./spine-location.js"
import { Mode1Error } from "../import/mode1.errors.js"
import { loadLayout, titleOfSection } from "../import/gap-report.service.js"
import { ownerStepOf } from "../spine/section-registry.js"

export { elementPathOf, MAX_LOCATIONS } from "./spine-location.js"

export const formatLocationId = (n: number): string => `L${String(n).padStart(3, "0")}`

/** POST …/impact: tìm lại toàn bộ vị trí (thay lần trước) rồi khoá. */
export const runImpact = async (cr: IChangeRequest): Promise<void> => {
  assertCrStatus(cr, ["impact_review"], "impact_review")
  const record = await spineRepository.get(String(cr.projectId))
  if (!record) throw new Error("Không tìm thấy Spine của project")
  const spine = stripRecord(record)

  const seedTargets = new Set(cr.seed?.targets ?? [])
  const found = findSpineLocations(spine, cr.targets.entity_paths, cr.targets.keywords).map((f) =>
    seedTargets.has(f.path) && !f.found_by.includes("preview") ? { ...f, found_by: [...f.found_by, "preview" as const] } : f
  )
  // Phase 8: CR gộp thêm lệnh sau khi đã có đề xuất ⇒ vị trí đã có (đề xuất / kết luận / khoá) giữ nguyên, chỉ thêm
  // phần tử mới. Chưa có đề xuất nào ⇒ tìm lại như cũ (thay toàn bộ vị trí, trả khoá phần tử bị bỏ).
  const existing = await ChangeLocation.find({ projectId: cr.projectId, cr_id: cr.cr_id }).select("path location_id conclusion").lean()
  if (existing.some((l) => l.conclusion !== null)) {
    const have = new Set(existing.map((l) => l.path))
    const fresh = found.filter((f) => !have.has(f.path))
    if (!fresh.length) return
    const next = existing.reduce((n, l) => Math.max(n, Number(l.location_id.slice(1)) || 0), 0)
    await lockPaths(cr.projectId, cr.cr_id, fresh.map((f) => f.path))
    await ChangeLocation.insertMany(fresh.map((f, i) => ({ projectId: cr.projectId, cr_id: cr.cr_id, location_id: formatLocationId(next + i + 1), ...f })))
    return
  }
  if (!found.length) {
    // Đứng im ở impact_review với 0 vị trí làm nút "Tìm vị trí" trông như hỏng. Nói rõ: đích nào là mục còn trống
    // mà cũng không thêm mới được và CR đã nhắm vào gì. Mode 1 v3 không còn step ⇒ lối ra duy nhất là sửa mô tả CR.
    const layout = await loadLayout(String(cr.projectId))
    const empty = emptySectionTargets(spine, cr.targets.entity_paths).map((section_id) => ({
      section_id,
      title: titleOfSection(spine, section_id, layout),
      step_id: section_id.startsWith("custom:") ? null : ownerStepOf(section_id, spine)
    }))
    const emptyTitles = empty.map((e) => `"${e.title}"`).join(", ")
    throw new Mode1Error(
      "CR_NO_LOCATIONS",
      empty.length
        ? `Không có phần tử nào để sửa: ${emptyTitles} đang trống — sửa mô tả CR cho trỏ vào phần tử cụ thể rồi làm rõ lại`
        : "Không tìm được phần nào trong tài liệu khớp với change request — sửa mô tả (nêu mã hoặc tên phần tử) rồi làm rõ lại",
      { targets: { entity_paths: [...cr.targets.entity_paths], keywords: [...cr.targets.keywords] }, empty_sections: empty }
    )
  }
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
