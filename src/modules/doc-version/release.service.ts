import { assertNoMigrationRunning } from "../template-migration/migration-guard.js"
import { listChangesForRecord } from "../render/assemble.service.js"
import { captureTemplateSourceBinding } from "./template-source-binding.js"
/**
 * Release (Flow 6 nút 6.1–6.2): Lead chủ động, không gắn với một CR. FLF-171, plan §6 2F.
 * - Quét lại cờ (hồ sơ luật mode 1); còn cờ đỏ mở ⇒ `422 RELEASE_RED_FLAGS_OPEN` (BR-04, mode 1 không waive).
 * - Gom CR `written` từ lần release trước; version major tiếp theo; baseline `type: release` (snapshot Spine).
 * - Mode 1 v2 (FLF-186): bản sạch = **render snapshot Spine** lúc release (layout file upload, stamp `release`) — không
 *   còn accept-all trên file Track Changes. `file_ref` và `clean_file_ref` cùng trỏ bản render này.
 * - CR đang dở không chặn release: khoá phần tử (theo path) giữ nguyên, không phụ thuộc version.
 * Thứ tự: render + lưu file → baseline (Spine) → DocVersion; baseline lỗi ⇒ xoá file vừa lưu.
 */

import { ApiError } from "../../shared/utils/api-error.js"
import { stripRecord } from "../import/check.service.js"
import { Mode1Error } from "../import/mode1.errors.js"
import { mode1RuleProfileFor } from "../import/mode1-guard.js"
import { snapshotBaseline } from "../pipeline/s9/baseline.service.js"
import { ChangeRequest } from "../change-request/change-request.model.js"
import { Project } from "../project/project.model.js"
import * as flagsService from "../spine/flags.service.js"
import * as spineRepository from "../spine/spine.repository.js"
import type { Baseline as BaselineEntry } from "../spine/spine.types.js"
import { docFileStore } from "./doc-file.store.js"
import { DocVersion, type IDocVersion } from "./doc-version.model.js"
import { listDocVersions } from "./doc-version.service.js"
import { renderVersionFile } from "./render-version.js"
import { withVersionSlot } from "./version-allocator.js"
import { buildReleaseTracked } from "./release-tracked.js"
import { assertPackageUnchangedSinceSubmit } from "./review-package.service.js"
import { proposeTemplateFromBaseline } from "../import/template-skeleton.service.js"
import { resolveRecordLanguage, summarizeRecordRows } from "./record-summary.service.js"

export interface ReleaseResult {
  version: IDocVersion
  baseline: BaselineEntry
  cr_ids: string[]
  spine_version: number
}

export interface ReleaseOptions {
  /** FLF-492 (M4-02): AI viết gọn mô tả các dòng CR của gói trong Record of Changes. Mặc định tắt; lỗi AI không chặn phát hành. */
  conciseRecord?: boolean
}

export const release = async (projectId: string, userId: string, baseVersion: number, options: ReleaseOptions = {}): Promise<ReleaseResult> => {
  await assertNoMigrationRunning(projectId)
  const before = await spineRepository.get(projectId)
  if (!before) throw new ApiError(404, "Không tìm thấy dữ liệu tài liệu của dự án.", spineRepository.SPINE_NOT_FOUND)
  if (before.spine_version !== baseVersion) {
    throw new ApiError(409, "Tài liệu vừa được thay đổi ở phiên khác. Vui lòng tải lại rồi thử lại.", spineRepository.SPINE_VERSION_CONFLICT)
  }
  await assertPackageUnchangedSinceSubmit(projectId, before.baseline_submission)
  // 6.1 "cờ đỏ = 0" gồm cả luật S-9 (giả định chưa xác nhận) — như ký baseline của mode 2
  const checked = await flagsService.recompute(projectId, { by: userId, ruleProfile: await mode1RuleProfileFor(projectId), atBaseline: true })
  const red = checked.flags.filter((f) => f.level === "red" && f.resolved_at === null)
  if (red.length) throw new Mode1Error("RELEASE_RED_FLAGS_OPEN", `Còn ${red.length} cờ đỏ - xử lý qua change request rồi release`, { flags: red })

  // FLF-466: số major kế tiếp cấp nguyên tử (cùng khoá với CR / thay đổi hệ thống) — không ra `2.0` hai lần, không ra `1.4` sau `2.0`
  const { version, baseline, crIds, fileRef, spineVersion } = await withVersionSlot(projectId, "major", async ({ latest, next }) => {
    const versions = await listDocVersions(projectId)
    const lastRelease = versions.find((v) => v.kind === "release")
    const crIds = [
      ...new Set(
        versions
          .filter((v) => v.kind === "cr_revision" && (!lastRelease || v.createdAt > lastRelease.createdAt))
          .reverse()
          .flatMap((v) => v.cr_ids)
      )
    ]

    const record = (await spineRepository.get(projectId))!
    const projectName = (await Project.findById(projectId, { name: 1 }).lean())?.name ?? "SRS"
    // §I của chính file release phải có dòng của nó (Record of Changes khớp số version) — lô baseline ghi sau khi render
    const releaseRow = { txn: `release:${next}`, at: new Date().toISOString(), by: userId, reason: `Baseline ${next}`, op: "add", path: "baselines[]", step_id: null }
    const templateSource = await captureTemplateSourceBinding(projectId)
    // FLF-492: viết gọn mô tả dòng CR trước khi dựng bản sạch (bảng đọc lại từ `ChangeRequest.record_summaries`). Không bao giờ làm hỏng phát hành.
    if (options.conciseRecord && crIds.length > 0) {
      try {
        await summarizeRecordRows(projectId, userId, stripRecord(record), crIds, await resolveRecordLanguage(projectId, templateSource), `release:${next}`)
      } catch (err) {
        console.warn(`[release] ${projectId}: bỏ qua bước AI viết gọn:`, err instanceof Error ? err.message : err)
      }
    }
    const recordSnapshot = templateSource ? await listChangesForRecord(projectId) : null
    // `releasing`: CR của gói in Version = số lần phát hành này ngay trong chính file (DocVersion chưa tồn tại lúc render)
    const buffer = await renderVersionFile(projectId, projectName, stripRecord(record), {
      version: next,
      stampSource: "release",
      pendingRecord: [releaseRow],
      releasing: { version: next, crIds },
      templateSource,
      ...(recordSnapshot ? { recordChanges: recordSnapshot } : {})
    })
    const fileRef = await docFileStore().save(buffer, { projectId, kind: "version", name: next })

    let baseline: BaselineEntry
    let spineVersion: number
    try {
      const snap = await snapshotBaseline(projectId, stripRecord(record), {
        base_version: record.spine_version,
        version: next,
        type: "release",
        doc_version: next,
        by: userId,
        step_id: null
      })
      baseline = snap.baseline
      spineVersion = snap.spine_version
    } catch (err) {
      await docFileStore().remove(fileRef)
      throw err
    }

    // FLF-466 phase 03: Track Changes so với lần ổn định trước; lỗi không chặn phát hành
    const tracked = await buildReleaseTracked({ projectId, userId, version: next, buffer, versionsNewestFirst: versions, crIds, spine: stripRecord(record) })
    const version = await DocVersion.create({
      projectId,
      version: next,
      kind: "release",
      file_ref: fileRef,
      clean_file_ref: fileRef,
      tracked_file_ref: tracked.tracked_file_ref,
      tracked_unavailable_reason: tracked.tracked_unavailable_reason,
      based_on: latest.version,
      cr_ids: crIds,
      baseline_ref: baseline.id,
      template_source: templateSource,
      record_snapshot: recordSnapshot ? [...recordSnapshot, releaseRow] : null,
      created_by: userId
    })
    return { version, baseline, crIds, fileRef, spineVersion }
  })
  // FLF-466 (BF §4): CR nằm trong bản phát hành ⇒ "đã phát hành" (không đặt ở settleAfterRelease: Lead tự phát hành thì hàm đó thoát sớm)
  if (crIds.length) await ChangeRequest.updateMany({ projectId, cr_id: { $in: crIds }, status: { $ne: "released" } }, { $set: { status: "released" } })
  // FLF-395 (D12): khung đổi ở lần phát hành này ⇒ bản mới của mẫu khung tự lưu (lỗi không chặn phát hành)
  await proposeTemplateFromBaseline(projectId, userId, fileRef)
  return { version, baseline, cr_ids: crIds, spine_version: spineVersion }
}
