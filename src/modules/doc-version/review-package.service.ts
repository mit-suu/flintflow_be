/**
 * review-package.service.ts — "Gói duyệt" mode 1 (FLF-330; business-flow §3.2 C-7, §2 "Bản nháp / Gói duyệt / Baseline").
 * ─────────────────────────────────────────────────────────────────
 * CR = commit: BA xác nhận ⇒ ghi ngay vào bản nháp chung (`change-request.service.submitCr`). Gói duyệt = pull request:
 * mọi CR đã ghi (`written`) kể từ lần phát hành trước. BA **gửi duyệt** (cờ đỏ = 0) ⇒ bản nháp khoá; Lead **duyệt cả gói**
 * (= `release.service.release`, phát hành số chính) hoặc **yêu cầu sửa** kèm lý do ⇒ mở khoá. Lead tự làm thì phát hành
 * thẳng, không qua bước gửi.
 *
 * Gói không có model riêng: danh sách CR suy từ `DocVersion.cr_revision` sau lần release gần nhất, trạng thái chờ duyệt
 * nằm trên chính Spine ở `baseline_submission` (cùng field với nộp baseline 1.0 của mode 2 — FLF-275/293) nên
 * `assertDraftUnlocked` khoá mọi đường sửa, kể cả `/changes` của mode 2 sau khi chuyển sang luồng import (FLF-318/314).
 */

import mongoose from "mongoose"
import { ApiError } from "../../shared/utils/api-error.js"
import { ChangeRequest, type IChangeRequest } from "../change-request/change-request.model.js"
import { Membership } from "../organization/membership.model.js"
import { notify } from "../notification/notification.service.js"
import { MODE1_RULE_PROFILE } from "../import/mode1-rule-profile.js"
import { Mode1Error } from "../import/mode1.errors.js"
import * as flagsService from "../spine/flags.service.js"
import { applyTransaction } from "../spine/op-engine.js"
import * as spineRepository from "../spine/spine.repository.js"
import type { BaselineSubmission, Flag } from "../spine/spine.types.js"
import type { ReviewPackageDto, ReviewPackageCrDto } from "./doc-version.dto.js"
import { listDocVersions } from "./doc-version.service.js"
import { IMPORTED_DOC_VERSIONS, isReleaseVersion, nextMajor } from "./versioning.js"

export interface PackageActor {
  projectId: string
  projectName: string
  orgId: string
  userId: string
}

/** Mã CR đã ghi vào bản nháp kể từ lần phát hành gần nhất (thứ tự ghi), cùng version bản nháp mới nhất và bản phát hành gốc. */
export const pendingCrIds = async (projectId: string): Promise<{ crIds: string[]; latest: string | null; base: string | null }> => {
  const versions = await listDocVersions(projectId)
  const latest = versions[0] ?? null
  const lastRelease = versions.find((v) => v.kind === "release") ?? null
  const crIds = [
    ...new Set(
      versions
        .filter((v) => v.kind === "cr_revision" && (!lastRelease || v.createdAt > lastRelease.createdAt))
        .reverse()
        .flatMap((v) => v.cr_ids)
    )
  ]
  const imported = versions.find((v) => v.kind === "imported") ?? null
  return { crIds, latest: latest?.version ?? null, base: lastRelease?.version ?? (imported ? "v0" : null) }
}

/** "1.0 · 3 thay đổi chưa duyệt" — nhãn bản nháp theo business-flow §2 (chỉ số chính, không số phụ). */
export const draftLabel = (base: string | null, pendingCount: number): string => {
  const root = base ?? "v0"
  return pendingCount > 0 ? `${root} · ${pendingCount} thay đổi chưa duyệt` : root
}

const toCrDto = (cr: IChangeRequest): ReviewPackageCrDto => ({
  cr_id: cr.cr_id,
  title: cr.title,
  requester: cr.requester,
  source: { kind: cr.source.kind, ref: cr.source.ref ?? null },
  result_doc_version: cr.result_doc_version,
  written_at: (cr.updatedAt ?? cr.createdAt).toISOString()
})

/** Trạng thái gói hiện tại của dự án (mọi vai trò đọc được). */
export const getPackage = async (projectId: string): Promise<ReviewPackageDto> => {
  const record = await spineRepository.get(projectId)
  if (!record) throw new ApiError(404, "Không tìm thấy dữ liệu tài liệu của dự án.", spineRepository.SPINE_NOT_FOUND)
  const { crIds, latest, base } = await pendingCrIds(projectId)
  const crs = crIds.length ? await ChangeRequest.find({ projectId, cr_id: { $in: crIds } }).lean<IChangeRequest[]>() : []
  const byId = new Map(crs.map((c) => [c.cr_id, c]))
  const submission = record.baseline_submission ?? null
  const redOpen = record.flags.filter((f) => f.level === "red" && f.resolved_at === null).length
  const status: ReviewPackageDto["status"] = submission?.status === "pending" ? "pending" : submission?.status === "rejected" ? "changes_requested" : "drafting"
  return {
    status,
    base_version: base,
    latest_version: latest,
    next_version: latest ? nextMajor(latest) : null,
    draft_label: draftLabel(base, crIds.length),
    change_requests: crIds.map((id) => byId.get(id)).filter((c): c is IChangeRequest => !!c).map(toCrDto),
    red_open: redOpen,
    submission,
    spine_version: record.spine_version
  }
}

/** Gói đang chờ Lead duyệt ⇒ bản nháp khoá: không tạo / xác nhận / gộp CR (business-flow §3.2 C-7). */
export const assertPackageNotPending = (submission: BaselineSubmission | null | undefined): void => {
  if (submission?.status === "pending") {
    throw new Mode1Error("PACKAGE_PENDING", "Gói thay đổi đang chờ Lead duyệt nên bản nháp tạm khoá. Chờ Lead duyệt hoặc yêu cầu sửa rồi làm tiếp.")
  }
}

const notifyLeads = async (actor: PackageActor, crIds: string[], submission: BaselineSubmission): Promise<void> => {
  const leads = await Membership.find({ organizationId: actor.orgId, role: "lead", userId: { $ne: actor.userId } }).select("userId").lean()
  await Promise.all(
    leads.map((m) =>
      notify(String(m.userId), {
        type: "review_package_submitted",
        title: `${actor.projectName}: ${crIds.length} thay đổi chờ bạn duyệt`,
        body: `Gói ${crIds.join(", ")} đã qua kiểm tra, không còn cờ đỏ. Duyệt cả gói để phát hành bản mới, hoặc yêu cầu sửa.`,
        link: `/projects/${actor.projectId}`,
        organizationId: actor.orgId,
        meta: { projectId: actor.projectId, cr_ids: crIds, spine_version: submission.spine_version }
      })
    )
  )
}

/**
 * C-7 BA bấm **Gửi duyệt**: gom mọi CR đã ghi từ baseline trước; cờ đỏ = 0 (hồ sơ luật mode 1, quét lại như release);
 * đặt `baseline_submission = pending` ⇒ bản nháp khoá; báo Lead. Lead tự nộp cũng được (rồi tự duyệt).
 */
export const submitPackage = async (actor: PackageActor, baseVersion: number): Promise<ReviewPackageDto> => {
  const record = await spineRepository.get(actor.projectId)
  if (!record) throw new ApiError(404, "Không tìm thấy dữ liệu tài liệu của dự án.", spineRepository.SPINE_NOT_FOUND)
  if (record.spine_version !== baseVersion) {
    throw new ApiError(409, "Tài liệu vừa được thay đổi ở phiên khác. Vui lòng tải lại rồi thử lại.", spineRepository.SPINE_VERSION_CONFLICT)
  }
  if (record.baseline_submission?.status === "pending") {
    throw new ApiError(409, "Gói thay đổi đang chờ Lead duyệt — không gửi lại được.", "PACKAGE_ALREADY_SUBMITTED")
  }
  const { crIds } = await pendingCrIds(actor.projectId)
  if (crIds.length === 0) throw new Mode1Error("PACKAGE_EMPTY", "Chưa có thay đổi nào được ghi vào bản nháp kể từ lần phát hành trước — không có gì để gửi duyệt.")

  // BR-04: cờ đỏ = 0 — quét lại đúng như lúc release để Lead chắc chắn duyệt được
  const checked = await flagsService.recompute(actor.projectId, { by: actor.userId, ruleProfile: MODE1_RULE_PROFILE, atBaseline: true })
  const red: Flag[] = checked.flags.filter((f) => f.level === "red" && f.resolved_at === null)
  if (red.length) throw new Mode1Error("RELEASE_RED_FLAGS_OPEN", `Còn ${red.length} cờ đỏ — xử lý qua change request rồi gửi duyệt`, { flags: red })

  const submission: BaselineSubmission = {
    status: "pending",
    submitted_by: actor.userId,
    submitted_at: new Date().toISOString(),
    spine_version: checked.checked_at_version,
    decided_by: null,
    decided_at: null,
    reason: null,
    rejection_comment_ids: []
  }
  await applyTransaction(actor.projectId, {
    base_version: checked.checked_at_version,
    ops: [{ op: "set", path: "baseline_submission", value: submission, reason: `Gửi Lead duyệt gói ${crIds.join(", ")}` }],
    by: actor.userId,
    step_id: null,
    reason: "Gửi duyệt gói thay đổi"
  })
  await notifyLeads(actor, crIds, submission)
  return getPackage(actor.projectId)
}

/** C-7 Lead **Yêu cầu sửa** kèm lý do ⇒ `rejected`, mở khoá bản nháp; BA chat để sửa hoặc hoàn tác (CR mới) rồi gửi lại. */
export const requestChanges = async (actor: PackageActor, input: { base_version: number; reason: string }): Promise<ReviewPackageDto> => {
  const record = await spineRepository.get(actor.projectId)
  if (!record) throw new ApiError(404, "Không tìm thấy dữ liệu tài liệu của dự án.", spineRepository.SPINE_NOT_FOUND)
  if (record.spine_version !== input.base_version) {
    throw new ApiError(409, "Tài liệu vừa được thay đổi ở phiên khác. Vui lòng tải lại rồi thử lại.", spineRepository.SPINE_VERSION_CONFLICT)
  }
  const current = record.baseline_submission
  if (current?.status !== "pending") throw new ApiError(422, "Không có gói nào đang chờ duyệt.", "NO_PENDING_SUBMISSION")

  const submission: BaselineSubmission = {
    ...current,
    status: "rejected",
    decided_by: actor.userId,
    decided_at: new Date().toISOString(),
    reason: input.reason,
    rejection_comment_ids: current.rejection_comment_ids ?? []
  }
  await applyTransaction(actor.projectId, {
    base_version: input.base_version,
    ops: [{ op: "set", path: "baseline_submission", value: submission, reason: "Lead yêu cầu sửa gói thay đổi" }],
    by: actor.userId,
    step_id: null,
    reason: "Yêu cầu sửa gói thay đổi"
  })
  if (current.submitted_by !== actor.userId) {
    void notify(current.submitted_by, {
      type: "review_package_changes_requested",
      title: `${actor.projectName}: Lead yêu cầu sửa gói thay đổi`,
      body: input.reason.slice(0, 300),
      link: `/projects/${actor.projectId}`,
      organizationId: actor.orgId,
      meta: { projectId: actor.projectId }
    })
  }
  return getPackage(actor.projectId)
}

/** Sau khi phát hành (Lead duyệt cả gói): xoá trạng thái chờ và báo người đã gửi. Gọi từ `release.service`. */
export const settleAfterRelease = async (actor: PackageActor, released: { version: string; cr_ids: string[]; spine_version: number }): Promise<number> => {
  const record = await spineRepository.get(actor.projectId)
  if (!record) return released.spine_version
  const current = record.baseline_submission
  if (!current) return record.spine_version
  const applied = await applyTransaction(actor.projectId, {
    base_version: record.spine_version,
    ops: [{ op: "set", path: "baseline_submission", value: null, reason: `Lead đã duyệt gói, phát hành ${released.version}` }],
    by: actor.userId,
    step_id: null,
    reason: "Phát hành gói thay đổi"
  })
  if (current.submitted_by !== actor.userId && mongoose.isValidObjectId(current.submitted_by)) {
    void notify(current.submitted_by, {
      type: "review_package_released",
      title: `${actor.projectName}: Lead đã duyệt gói, phát hành bản ${released.version}`,
      body: `Gói ${released.cr_ids.join(", ")} đã vào bản ${released.version}. Tải bản sạch và bản có đánh dấu ở mục Version.`,
      link: `/projects/${actor.projectId}`,
      organizationId: actor.orgId,
      meta: { projectId: actor.projectId, version: released.version, cr_ids: released.cr_ids }
    })
  }
  return applied.spine_version
}

/** Bản phát hành hay bản gốc import — không phải bản nháp sau CR. */
export const isStableVersion = (version: string): boolean => IMPORTED_DOC_VERSIONS.includes(version) || isReleaseVersion(version)
