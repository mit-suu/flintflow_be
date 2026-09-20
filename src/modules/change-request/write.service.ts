/**
 * C-7 ghi thay đổi đã duyệt (nút 3.14) — ghi ngay khi duyệt xong (D4). FLF-171, plan §6 2E; mode 1 v2 (FLF-186).
 * Spine là nguồn sự thật (D1): kiểm giá trị tại path chưa đổi → chạy khô op (`by = cr_id`) → **render** version minor
 * mới từ Spine dự kiến (layout file upload + stamp, §I có dòng của CR này) → lưu file + `DocVersion` → op Spine
 * (bước ghi **cuối** — FLF-178: op engine không nhận Mongo session, Spine là bước duy nhất không hoàn tác được) →
 * recompute cờ → mở khoá → ghép lại bản làm việc.
 * Lỗi trước/tại bước Spine ⇒ xoá version + file vừa tạo; Spine và CR giữ nguyên (chạy lại an toàn).
 * Recompute cờ / ghép bản làm việc lỗi sau khi Spine đã ghi ⇒ không huỷ bản ghi (giá trị suy diễn, lần sau tính lại).
 * Vị trí `comment` không đổi Spine — ghi chú nằm ở CR (bản tải "có đánh dấu" theo section: để sau — plan v2 §11).
 */

import { ApiError } from "../../shared/utils/api-error.js"
import { docFileStore } from "../doc-version/doc-file.store.js"
import { DocVersion } from "../doc-version/doc-version.model.js"
import { latestDocVersion } from "../doc-version/doc-version.service.js"
import { renderVersionFile } from "../doc-version/render-version.js"
import { nextMinor } from "../doc-version/versioning.js"
import { stripRecord } from "../import/check.service.js"
import { MODE1_RULE_PROFILE } from "../import/mode1-rule-profile.js"
import { Project } from "../project/project.model.js"
import { assemble } from "../render/assemble.service.js"
import * as flagsService from "../spine/flags.service.js"
import { applyTransaction, planTransaction } from "../spine/op-engine.js"
import { userOpSchema, type Op } from "../spine/op.types.js"
import * as spineRepository from "../spine/spine.repository.js"
import type { IChangeRequest } from "./change-request.model.js"
import type { IChangeLocation } from "./change-location.model.js"
import { unlockPaths } from "./lock.service.js"
import { elementValue, valueText } from "./spine-location.js"
import { valueChanged } from "./verify.service.js"

/** Ghi các vị trí đã duyệt thành version minor mới. Trả version mới. */
export const writeApproved = async (cr: IChangeRequest, userId: string, approved: IChangeLocation[], baseVersion: number): Promise<string> => {
  const projectId = String(cr.projectId)
  const record = await spineRepository.get(projectId)
  if (!record) throw new ApiError(404, "Không tìm thấy Spine của dự án", spineRepository.SPINE_NOT_FOUND)
  if (record.spine_version !== baseVersion) {
    throw new ApiError(409, "Tài liệu vừa được thay đổi ở phiên khác. Vui lòng tải lại rồi thử lại.", spineRepository.SPINE_VERSION_CONFLICT)
  }
  const current = stripRecord(record)
  const edits = approved.filter((l) => l.conclusion === "edit" && l.proposal)
  for (const loc of edits) if (valueText(elementValue(current, loc.path)) !== loc.proposal!.old_text) throw valueChanged(loc)

  // 0. Chạy khô op Spine: op sai / phá bất biến bị chặn trước khi ghi gì
  const ops: Op[] = edits.flatMap((l) => (l.proposal!.spine_ops ?? []).map((raw) => userOpSchema.parse(raw)))
  const txn = { base_version: baseVersion, ops, by: cr.cr_id, reason: `${cr.cr_id}: ${cr.title}`, step_id: null }
  const plan = ops.length ? planTransaction(current, txn, { startSeq: 1 }) : null

  // 1. File version mới = render Spine dự kiến
  const version = (await latestDocVersion(projectId))!
  const next = nextMinor(version.version)
  const projectName = (await Project.findById(projectId, { name: 1 }).lean())?.name ?? "SRS"
  const buffer = await renderVersionFile(projectId, projectName, plan?.spine ?? current, {
    version: next,
    stampSource: "cr_revision",
    pendingRecord: (plan?.changes ?? []).map((c) => ({ txn: c.txn, at: c.at, by: c.by, reason: c.reason ?? null, op: c.op, step_id: c.step_id ?? null }))
  })
  const fileRef = await docFileStore().save(buffer, { projectId, kind: "version", name: next })

  let versionCreated = false
  let spineVersion = record.spine_version
  try {
    // 2. Version mới
    await DocVersion.create({ projectId, version: next, kind: "cr_revision", file_ref: fileRef, based_on: version.version, cr_ids: [cr.cr_id], baseline_ref: null, created_by: userId })
    versionCreated = true

    // 3. Spine — bước cuối; `base_version` chặn ghi đè nếu Spine đổi từ lúc chạy khô
    if (ops.length) spineVersion = (await applyTransaction(projectId, txn)).spine_version
  } catch (err) {
    if (versionCreated) await DocVersion.deleteOne({ projectId, version: next })
    await docFileStore().remove(fileRef)
    throw err
  }

  try {
    await flagsService.recompute(projectId, { by: cr.cr_id, ruleProfile: MODE1_RULE_PROFILE })
  } catch (err) {
    console.warn(`[C-7] ${cr.cr_id}: đã ghi ${next} nhưng recompute cờ lỗi — cờ sẽ được tính lại ở lần recompute sau`, err)
  }
  await unlockPaths(projectId, cr.cr_id)
  try {
    const latest = await spineRepository.get(projectId)
    await assemble(projectId, projectName, latest?.spine_version ?? spineVersion)
  } catch (err) {
    console.warn(`[C-7] ${cr.cr_id}: đã ghi ${next} nhưng ghép lại bản làm việc lỗi — workspace ghép lại khi mở`, err)
  }
  return next
}
