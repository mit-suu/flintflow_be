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
import { MODE1_RULE_PROFILE } from "../import/mode1-rule-profile.js"
import { snapshotBaseline } from "../pipeline/s9/baseline.service.js"
import { Project } from "../project/project.model.js"
import * as flagsService from "../spine/flags.service.js"
import * as spineRepository from "../spine/spine.repository.js"
import type { Baseline as BaselineEntry } from "../spine/spine.types.js"
import { docFileStore } from "./doc-file.store.js"
import { DocVersion, type IDocVersion } from "./doc-version.model.js"
import { listDocVersions } from "./doc-version.service.js"
import { renderVersionFile } from "./render-version.js"
import { nextMajor } from "./versioning.js"

export interface ReleaseResult {
  version: IDocVersion
  baseline: BaselineEntry
  cr_ids: string[]
  spine_version: number
}

export const release = async (projectId: string, userId: string, baseVersion: number): Promise<ReleaseResult> => {
  const before = await spineRepository.get(projectId)
  if (!before) throw new ApiError(404, "Không tìm thấy Spine của dự án", spineRepository.SPINE_NOT_FOUND)
  if (before.spine_version !== baseVersion) {
    throw new ApiError(409, "Tài liệu vừa được thay đổi ở phiên khác. Vui lòng tải lại rồi thử lại.", spineRepository.SPINE_VERSION_CONFLICT)
  }
  const versions = await listDocVersions(projectId)
  const latest = versions[0]
  if (!latest) throw new Mode1Error("DOC_VERSION_NOT_FOUND", "Chưa có version tài liệu nào để release")

  const checked = await flagsService.recompute(projectId, { by: userId, ruleProfile: MODE1_RULE_PROFILE })
  const red = checked.flags.filter((f) => f.level === "red" && f.resolved_at === null)
  if (red.length) throw new Mode1Error("RELEASE_RED_FLAGS_OPEN", `Còn ${red.length} cờ đỏ — xử lý qua change request rồi release`, { flags: red })

  const lastRelease = versions.find((v) => v.kind === "release")
  const crIds = [
    ...new Set(
      versions
        .filter((v) => v.kind === "cr_revision" && (!lastRelease || v.createdAt > lastRelease.createdAt))
        .reverse()
        .flatMap((v) => v.cr_ids)
    )
  ]
  const next = nextMajor(latest.version)

  const record = (await spineRepository.get(projectId))!
  const projectName = (await Project.findById(projectId, { name: 1 }).lean())?.name ?? "SRS"
  const buffer = await renderVersionFile(projectId, projectName, stripRecord(record), { version: next, stampSource: "release" })
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

  const version = await DocVersion.create({
    projectId,
    version: next,
    kind: "release",
    file_ref: fileRef,
    clean_file_ref: fileRef,
    based_on: latest.version,
    cr_ids: crIds,
    baseline_ref: baseline.id,
    created_by: userId
  })
  return { version, baseline, cr_ids: crIds, spine_version: spineVersion }
}
