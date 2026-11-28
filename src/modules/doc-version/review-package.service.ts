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

import { assertNoMigrationRunning } from "../template-migration/migration-guard.js"
import mongoose from "mongoose"
import { ApiError } from "../../shared/utils/api-error.js"
import { ChangeRequest, type IChangeRequest } from "../change-request/change-request.model.js"
import { Membership } from "../organization/membership.model.js"
import { notify } from "../notification/notification.service.js"
import { mode1RuleProfileFor } from "../import/mode1-guard.js"
import { Mode1Error } from "../import/mode1.errors.js"
import * as flagsService from "../spine/flags.service.js"
import { applyTransaction } from "../spine/op-engine.js"
import * as spineRepository from "../spine/spine.repository.js"
import type { BaselineSubmission, Flag } from "../spine/spine.types.js"
import type { ReviewPackageDto, ReviewPackageCrDto, ReviewPackageRoundDto, ReviewPackageSystemChangeDto } from "./doc-version.dto.js"
import { Change as ChangeModel } from "../spine/change.model.js"
import { DERIVED_PATH } from "../template-migration/apply-plan.js"
import { listDocVersions } from "./doc-version.service.js"
import { DocVersion } from "./doc-version.model.js"
import { nextMajor } from "./versioning.js"
import { assertNoRunningStep } from "../pipeline/run-state.service.js"
import { trackedUnavailableReasonFor } from "./release-tracked.js"
import { stripRecord } from "../import/check.service.js"
import { captureTemplateSourceBinding } from "./template-source-binding.js"
import { estimateRecordSummaryCredits, resolveRecordLanguage } from "./record-summary.service.js"

export interface PackageActor {
  projectId: string
  projectName: string
  orgId: string
  userId: string
}

/**
 * Gói = mọi CR **và thay đổi hệ thống** đã ghi kể từ lần phát hành gần nhất (BF §2, FLF-466): mã CR (thứ tự ghi), các thay đổi hệ thống
 * (đổi mẫu, hoàn tác, vẽ lại / dùng ảnh gốc), version bản nháp mới nhất và bản phát hành gốc.
 */
export const pendingCrIds = async (projectId: string): Promise<{ crIds: string[]; systemChanges: ReviewPackageSystemChangeDto[]; latest: string | null; base: string | null }> => {
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
  const systemChanges = versions
    .filter((v) => v.kind === "system_change" && v.system_change && (!lastRelease || v.createdAt > lastRelease.createdAt))
    .reverse()
    .map((v) => ({ version: v.version, type: v.system_change!.type, ref: v.system_change!.ref, summary: v.system_change!.summary, created_by: String(v.created_by), created_at: v.createdAt.toISOString() }))
  const imported = versions.find((v) => v.kind === "imported") ?? null
  return { crIds, systemChanges, latest: latest?.version ?? null, base: lastRelease?.version ?? (imported ? "v0" : null) }
}

/** "1.0 · 3 thay đổi chưa duyệt" — nhãn bản nháp theo business-flow §2 (chỉ số chính, không số phụ). */
export const draftLabel = (base: string | null, pendingCount: number): string => {
  // Chưa phát hành bản nào: nhãn cho người đọc là bản gốc 0.1 (business-flow §2) — `base_version` vẫn giữ mã `v0` cho client
  const root = !base || base === "v0" ? "Bản gốc 0.1" : base
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

/**
 * FLF-480 (B13): `submitPackage` (`:138-147`) ghi đè `baseline_submission` bằng một bản mới mỗi lần gửi lại ⇒ lý do
 * "Yêu cầu sửa" của vòng trước chỉ còn lại trong change log, không phải trên chính Spine. Không đổi schema Spine —
 * dựng lại các vòng đã bị ghi đè kể từ lần phát hành gần nhất (hoặc từ đầu nếu chưa phát hành bản nào), mới nhất trước.
 */
const previousRounds = async (projectId: string, submission: BaselineSubmission | null): Promise<ReviewPackageRoundDto[]> => {
  const versions = await listDocVersions(projectId)
  const lastRelease = versions.find((v) => v.kind === "release") ?? null
  const changes = await spineRepository.listChanges(projectId)
  const rounds: ReviewPackageRoundDto[] = []
  for (const change of changes) {
    if (change.path !== "baseline_submission") continue
    if (lastRelease && new Date(change.at).getTime() <= lastRelease.createdAt.getTime()) continue
    const value = change.value as BaselineSubmission | null
    if (value?.status === "rejected" && value.decided_by && value.decided_at) {
      rounds.push({ decided_by: value.decided_by, decided_at: value.decided_at, reason: value.reason ?? null })
    }
  }
  // Vòng đang hiệu lực (Lead vừa yêu cầu sửa, BA chưa gửi lại) đã hiện qua `submission` — không lặp lại ở "vòng trước".
  const last = rounds[rounds.length - 1]
  if (submission?.status === "rejected" && last && last.decided_at === submission.decided_at) rounds.pop()
  return rounds.reverse()
}

/** FLF-492: credit ước tính cho tuỳ chọn "AI viết gọn" khi phát hành; lỗi ước tính không làm hỏng việc đọc gói ⇒ 0. */
const conciseRecordCredits = async (projectId: string, record: Parameters<typeof stripRecord>[0], crIds: readonly string[]): Promise<number> => {
  if (crIds.length === 0) return 0
  try {
    const language = await resolveRecordLanguage(projectId, await captureTemplateSourceBinding(projectId))
    return await estimateRecordSummaryCredits(projectId, stripRecord(record), crIds, language)
  } catch (err) {
    console.warn(`[review-package] ${projectId}: không ước tính được credit viết gọn:`, err instanceof Error ? err.message : err)
    return 0
  }
}

/** Trạng thái gói hiện tại của dự án (mọi vai trò đọc được). */
export const getPackage = async (projectId: string): Promise<ReviewPackageDto> => {
  const record = await spineRepository.get(projectId)
  if (!record) throw new ApiError(404, "Không tìm thấy dữ liệu tài liệu của dự án.", spineRepository.SPINE_NOT_FOUND)
  const { crIds, systemChanges, latest, base } = await pendingCrIds(projectId)
  const crs = crIds.length ? await ChangeRequest.find({ projectId, cr_id: { $in: crIds } }).lean<IChangeRequest[]>() : []
  const byId = new Map(crs.map((c) => [c.cr_id, c]))
  const submission = record.baseline_submission ?? null
  const redOpen = record.flags.filter((f) => f.level === "red" && f.resolved_at === null).length
  const status: ReviewPackageDto["status"] = submission?.status === "pending" ? "pending" : submission?.status === "rejected" ? "changes_requested" : "drafting"
  const rounds = await previousRounds(projectId, submission)
  return {
    status,
    base_version: base,
    latest_version: latest,
    next_version: latest ? nextMajor(latest) : null,
    draft_label: draftLabel(base, crIds.length + systemChanges.length),
    change_requests: crIds.map((id) => byId.get(id)).filter((c): c is IChangeRequest => !!c).map(toCrDto),
    system_changes: systemChanges,
    tracked_unavailable_reason: (await trackedUnavailableReasonFor(projectId, await listDocVersions(projectId))) === "template_translated" ? "template_translated" : null,
    red_open: redOpen,
    concise_record_credits: await conciseRecordCredits(projectId, record, crIds),
    submission,
    spine_version: record.spine_version,
    rounds
  }
}

/**
 * FLF-466 (red-team #5): Lead duyệt đúng bản đã gửi. Từ lúc gửi (`set baseline_submission` gần nhất) tới giờ không được có Change nội dung nào
 * (cờ / tiến độ tự tính không tính). Phát hành không qua bước gửi (Lead tự làm) thì không có gì để so.
 */
export const assertPackageUnchangedSinceSubmit = async (projectId: string, submission: BaselineSubmission | null | undefined): Promise<void> => {
  if (submission?.status !== "pending") return
  const sent = (await ChangeModel.findOne({ projectId, path: "baseline_submission", op: "set" }, { seq: 1 }, { sort: { seq: -1 }, lean: true })) as { seq: number } | null
  if (sent) {
    const later = await ChangeModel.exists({ projectId, seq: { $gt: sent.seq }, path: { $not: DERIVED_PATH } })
    if (later) throw new Mode1Error("PACKAGE_CHANGED_AFTER_SUBMIT", "Nội dung tài liệu đã thay đổi sau khi gói được gửi duyệt nên không phát hành đúng bản đã gửi. Yêu cầu BA gửi lại gói.")
  }
  if (submission.submitted_at) {
    const laterVersion = await DocVersion.exists({ projectId, kind: { $in: ["cr_revision", "system_change"] }, createdAt: { $gt: new Date(submission.submitted_at) } })
    if (laterVersion) throw new Mode1Error("PACKAGE_CHANGED_AFTER_SUBMIT", "Nội dung tài liệu đã thay đổi sau khi gói được gửi duyệt nên không phát hành đúng bản đã gửi. Yêu cầu BA gửi lại gói.")
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
        meta: { projectId: actor.projectId, projectName: actor.projectName, cr_ids: crIds, spine_version: submission.spine_version }
      })
    )
  )
}

/**
 * C-7 BA bấm **Gửi duyệt**: gom mọi CR đã ghi từ baseline trước; cờ đỏ = 0 (hồ sơ luật mode 1, quét lại như release);
 * đặt `baseline_submission = pending` ⇒ bản nháp khoá; báo Lead. Lead tự nộp cũng được (rồi tự duyệt).
 */
export const submitPackage = async (actor: PackageActor, baseVersion: number): Promise<ReviewPackageDto> => {
  await assertNoMigrationRunning(actor.projectId)
  await assertNoRunningStep(actor.projectId)
  const record = await spineRepository.get(actor.projectId)
  if (!record) throw new ApiError(404, "Không tìm thấy dữ liệu tài liệu của dự án.", spineRepository.SPINE_NOT_FOUND)
  if (record.spine_version !== baseVersion) {
    throw new ApiError(409, "Tài liệu vừa được thay đổi ở phiên khác. Vui lòng tải lại rồi thử lại.", spineRepository.SPINE_VERSION_CONFLICT)
  }
  if (record.baseline_submission?.status === "pending") {
    throw new ApiError(409, "Gói thay đổi đang chờ Lead duyệt - không gửi lại được.", "PACKAGE_ALREADY_SUBMITTED")
  }
  const { crIds, systemChanges } = await pendingCrIds(actor.projectId)
  // FLF-466: gói chỉ có thay đổi hệ thống vẫn gửi được (BF §2)
  if (crIds.length === 0 && systemChanges.length === 0) throw new Mode1Error("PACKAGE_EMPTY", "Chưa có thay đổi nào được ghi vào bản nháp kể từ lần phát hành trước - không có gì để gửi duyệt.")
  const items = [...crIds, ...systemChanges.map((s) => s.summary)]

  // BR-04: cờ đỏ = 0 — quét lại đúng như lúc release để Lead chắc chắn duyệt được
  const checked = await flagsService.recompute(actor.projectId, { by: actor.userId, ruleProfile: await mode1RuleProfileFor(actor.projectId), atBaseline: true })
  const red: Flag[] = checked.flags.filter((f) => f.level === "red" && f.resolved_at === null)
  if (red.length) throw new Mode1Error("RELEASE_RED_FLAGS_OPEN", `Còn ${red.length} cờ đỏ - xử lý qua change request rồi gửi duyệt`, { flags: red })

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
    ops: [{ op: "set", path: "baseline_submission", value: submission, reason: `Gửi Lead duyệt gói ${items.join(", ")}` }],
    by: actor.userId,
    step_id: null,
    reason: "Gửi duyệt gói thay đổi"
  })
  await notifyLeads(actor, items, submission)
  return getPackage(actor.projectId)
}

/** C-7 Lead **Yêu cầu sửa** kèm lý do ⇒ `rejected`, mở khoá bản nháp; BA chat để sửa hoặc hoàn tác (CR mới) rồi gửi lại. */
export const requestChanges = async (actor: PackageActor, input: { base_version: number; reason: string }): Promise<ReviewPackageDto> => {
  await assertNoMigrationRunning(actor.projectId)
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
      meta: { projectId: actor.projectId, projectName: actor.projectName, reason: input.reason.slice(0, 300) }
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
      meta: { projectId: actor.projectId, projectName: actor.projectName, version: released.version, cr_ids: released.cr_ids }
    })
  }
  return applied.spine_version
}
