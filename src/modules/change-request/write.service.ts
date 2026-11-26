import { listChangesForRecord } from "../render/assemble.service.js"
import { captureTemplateSourceBinding } from "../doc-version/template-source-binding.js"
/**
 * C-7 ghi thay đổi đã duyệt (nút 3.14) — ghi ngay khi duyệt xong (D4). FLF-171, plan §6 2E; mode 1 v2 (FLF-186).
 * Spine là nguồn sự thật (D1): kiểm giá trị tại path chưa đổi → chạy khô op (`by = cr_id`) → **render** version minor
 * mới từ Spine dự kiến (layout file upload + stamp, §I có dòng của CR này) → lưu file + `DocVersion` → op Spine
 * (bước ghi **cuối** — FLF-178: op engine không nhận Mongo session, Spine là bước duy nhất không hoàn tác được) →
 * vẽ lại hình lệch dữ liệu (mode 1 v3: không còn step nào vẽ lại — có hình mới thì in lại file version) → recompute cờ
 * → mở khoá → ghép lại bản làm việc.
 * Lỗi trước/tại bước Spine ⇒ xoá version + file vừa tạo; Spine và CR giữ nguyên (chạy lại an toàn).
 * Recompute cờ / ghép bản làm việc lỗi sau khi Spine đã ghi ⇒ không huỷ bản ghi (giá trị suy diễn, lần sau tính lại).
 * Vị trí `comment` không đổi Spine. Mode 1 v3 (BPMN 3.14, T6/T7): kèm bản **có đánh dấu** — Track Changes so với version
 * trước + comment của vị trí `comment`, tác giả = CR id — lưu `tracked_file_ref`; dựng lỗi thì bỏ qua, không chặn ghi.
 */

import { ApiError } from "../../shared/utils/api-error.js"
import { layoutRenderDeps, renderAllIfAvailable, renderChangedIfAvailable } from "../diagram/diagram.service.js"
import { addedScreenIds } from "../spine/use-case-propagation.js"
import { buildTrackedDocx, type TrackedComment } from "../doc-version/tracked-version.js"
import { assertNoMigrationRunning } from "../template-migration/migration-guard.js"
import { trackedPolicySince } from "../doc-version/migration-tracked-policy.js"
import { loadLayout, titleOfSection } from "../import/gap-report.service.js"
import { docFileStore } from "../doc-version/doc-file.store.js"
import { DocVersion } from "../doc-version/doc-version.model.js"
import { renderVersionFile } from "../doc-version/render-version.js"
import { withVersionSlot } from "../doc-version/version-allocator.js"
import { authorNameOf } from "../doc-version/system-change.service.js"
import { stripRecord } from "../import/check.service.js"
import { mode1RuleProfileFor } from "../import/mode1-guard.js"
import { Project } from "../project/project.model.js"
import { assemble } from "../render/assemble.service.js"
import * as flagsService from "../spine/flags.service.js"
import { applyTransaction, planTransaction, revertChanges } from "../spine/op-engine.js"
import { userOpSchema, type Op } from "../spine/op.types.js"
import { findingOps } from "../import/check.service.js"
import { pathLabel } from "../spine/human-labels.js"
import { sectionOfElement } from "./spine-location.js"
import { crReplacedValues, sweepOldValues, OLD_VALUE_LEFT_RULE } from "./old-value-left.js"
import * as spineRepository from "../spine/spine.repository.js"
import type { Change } from "../spine/spine.types.js"
import type { IChangeRequest } from "./change-request.model.js"
import { ChangeLocation, type IChangeLocation } from "./change-location.model.js"
import { unlockPaths } from "./lock.service.js"
import { keptOriginalAckOps } from "./diagram-location.js"
import { unchangedSince } from "./spine-location.js"
import { valueChanged } from "./verify.service.js"
import { scheduleEmbeddingSync } from "./embedding/embedding-sync.service.js"

/** Ghi các vị trí đã duyệt thành version minor mới. Trả version mới. */
export const writeApproved = async (cr: IChangeRequest, userId: string, approved: IChangeLocation[], baseVersion: number): Promise<string> => {
  const projectId = String(cr.projectId)
  await assertNoMigrationRunning(projectId)
  const record = await spineRepository.get(projectId)
  if (!record) throw new ApiError(404, "Không tìm thấy dữ liệu tài liệu của dự án.", spineRepository.SPINE_NOT_FOUND)
  if (record.spine_version !== baseVersion) {
    throw new ApiError(409, "Tài liệu vừa được thay đổi ở phiên khác. Vui lòng tải lại rồi thử lại.", spineRepository.SPINE_VERSION_CONFLICT)
  }
  const current = stripRecord(record)
  const edits = approved.filter((l) => l.conclusion === "edit" && l.proposal)
  for (const loc of edits) if (!unchangedSince(current, loc.path, loc.proposal!)) throw valueChanged(loc)

  // 0. Chạy khô op Spine: op sai / phá bất biến bị chặn trước khi ghi gì
  const ops: Op[] = edits.flatMap((l) => (l.proposal!.spine_ops ?? []).map((raw) => userOpSchema.parse(raw)))
  const txn = { base_version: baseVersion, ops, by: cr.cr_id, reason: `${cr.cr_id}: ${cr.title}`, step_id: null }
  const plan = ops.length ? planTransaction(current, txn, { startSeq: 1 }) : null

  // 1. File version mới = render Spine dự kiến. Số version cấp nguyên tử (FLF-466): CR, đổi mẫu, vẽ lại màn, phát hành không trùng số
  const author = `${cr.cr_id} (${await authorNameOf(userId)})`
  const projectName = (await Project.findById(projectId, { name: 1 }).lean())?.name ?? "SRS"
  const decidedAt = new Date()
  const layout = await loadLayout(projectId)
  const comments: TrackedComment[] = approved
    .filter((l) => l.conclusion === "comment" && l.proposal?.comment_text)
    .map((l) => ({ section_title: titleOfSection(current, l.section_id, layout), text: l.proposal!.comment_text! }))

  const slot = await withVersionSlot(projectId, "minor", async ({ latest, next }) => {
    const templateSource = await captureTemplateSourceBinding(projectId)
    const recordSnapshot = templateSource ? await listChangesForRecord(projectId) : null
    const buffer = await renderVersionFile(projectId, projectName, plan?.spine ?? current, {
      templateSource,
      ...(recordSnapshot ? { recordChanges: recordSnapshot } : {}),
      version: next,
      stampSource: "cr_revision",
      pendingRecord: (plan?.changes ?? []).map((c) => ({ txn: c.txn, at: c.at, by: c.by, reason: c.reason ?? null, op: c.op, path: c.path, step_id: c.step_id ?? null }))
    })
    const fileRef = await docFileStore().save(buffer, { projectId, kind: "version", name: next })
    // D11: giữa version trước và lần ghi này có đổi mẫu ⇒ chỉ so nội dung (bỏ heading + chữ hướng dẫn); đổi mẫu có dịch ⇒ không tạo bản đánh dấu
    const policy = await trackedPolicySince(projectId, latest.createdAt)
    const tracked = (file: Buffer) => (policy === "none" ? Promise.resolve(null) : saveTracked(projectId, cr.cr_id, author, latest.file_ref, file, next, comments, decidedAt, policy === "content_only"))
    const trackedRef = await tracked(buffer)

    let versionCreated = false
    let spineVersion = record.spine_version
    try {
      // 2. Version mới (FLF-466: luôn lưu `spine_snapshot` để in lại / dịch bản nháp)
      await DocVersion.create({
        projectId,
        version: next,
        kind: "cr_revision",
        file_ref: fileRef,
        tracked_file_ref: trackedRef,
        based_on: latest.version,
        cr_ids: [cr.cr_id],
        baseline_ref: null,
        template_source: templateSource,
        record_snapshot: recordSnapshot ? [...recordSnapshot, ...(plan?.changes ?? []).map((c) => ({ txn: c.txn, at: c.at, by: c.by, reason: c.reason ?? null, op: c.op, path: c.path, step_id: c.step_id ?? null }))] : null,
        spine_snapshot: plan?.spine ?? current,
        created_by: userId
      })
      versionCreated = true

      // 3. Spine — bước cuối; `base_version` chặn ghi đè nếu Spine đổi từ lúc chạy khô
      if (ops.length) spineVersion = (await applyTransaction(projectId, txn)).spine_version
    } catch (err) {
      if (versionCreated) await DocVersion.deleteOne({ projectId, version: next })
      await docFileStore().remove(fileRef)
      if (trackedRef) await docFileStore().remove(trackedRef)
      throw err
    }
    return { next, fileRef, trackedRef, tracked, spineVersion }
  })
  const { next, fileRef, trackedRef, tracked } = slot
  // `let`: bước "giữ hình gốc" bên dưới có thể ghi thêm một lượt
  let { spineVersion } = slot

  // "Giữ hình gốc": đóng dấu hình được giữ theo dữ liệu sau CR ⇒ cờ "Hình gốc lệch dữ liệu" không bật ngay lại. Lượt ghi riêng
  // sau cùng: không đổi chữ hay hình của file vừa in; lỗi chỉ ghi log (cờ vàng còn đó, không mất dữ liệu)
  // `approved` chỉ có vị trí sửa / ghi chú; vị trí "giữ hình gốc" là `not_related` do người dùng tự chọn
  const kept = await ChangeLocation.find({ projectId: cr.projectId, cr_id: cr.cr_id, found_by: "diagram", conclusion: "not_related", manual: true })
  const ackOps = keptOriginalAckOps(plan?.spine ?? current, kept)
  if (ackOps.length) {
    try {
      spineVersion = (await applyTransaction(projectId, { base_version: spineVersion, ops: ackOps, by: cr.cr_id, reason: `${cr.cr_id}: giữ hình gốc`, step_id: null })).spine_version
    } catch (err) {
      console.warn(`[C-7] ${cr.cr_id}: đã ghi ${next} nhưng ghi nhận "giữ hình gốc" lỗi - cờ hình gốc lệch còn hiện`, err)
    }
  }

  // FLF-318: CR thêm use case / màn ⇒ bố cục màn mới vẽ như chat FLF-311 (wireframe của model), không để cờ `diagram_stale`
  const newScreens = plan ? addedScreenIds(current, plan.spine) : []
  await redrawDiagrams(projectId, cr.cr_id, userId, projectName, next, { file: fileRef, tracked: trackedRef }, tracked, newScreens)

  try {
    // Mode 1 luôn ở sau baseline v0 ⇒ tính cả luật S-9: CR xác nhận giả định thì cờ `unconfirmed_assumption` đóng ngay
    await flagsService.recompute(projectId, { by: cr.cr_id, ruleProfile: await mode1RuleProfileFor(projectId), atBaseline: true })
  } catch (err) {
    console.warn(`[C-7] ${cr.cr_id}: đã ghi ${next} nhưng recompute cờ lỗi - cờ sẽ được tính lại ở lần recompute sau`, err)
  }
  await flagOldValuesLeft(projectId, cr, approved)
  await unlockPaths(projectId, cr.cr_id)
  try {
    const latest = await spineRepository.get(projectId)
    await assemble(projectId, projectName, latest?.spine_version ?? spineVersion)
  } catch (err) {
    console.warn(`[C-7] ${cr.cr_id}: đã ghi ${next} nhưng ghép lại bản làm việc lỗi - workspace ghép lại khi mở`, err)
  }
  // Spine vừa đổi ⇒ embed lại phần tử đổi chữ cho C-3 của CR sau — chạy nền, không chặn/không làm hỏng C-7
  if (ops.length) scheduleEmbeddingSync(projectId)
  return next
}

/**
 * FLF-483 (lỗi #32): lượt quét sau khi ghi — CR đổi một giá trị mà phần tử khác (hoặc chữ spec của mockup) còn ghi giá trị cũ
 * ⇒ cờ vàng cho từng phần tử, không chặn. Bỏ phần tử C-3 kết luận "không liên quan" và chỗ BA đã chọn "giữ nguyên". Lỗi chỉ
 * ghi log: Spine đã ghi, cờ lệch sẽ không làm hỏng bản ghi.
 */
const flagOldValuesLeft = async (projectId: string, cr: IChangeRequest, approved: readonly IChangeLocation[]): Promise<void> => {
  try {
    const replaced = crReplacedValues(approved)
    if (!replaced.size) return
    const notRelated: string[] = await ChangeLocation.find({ projectId: cr.projectId, cr_id: cr.cr_id, conclusion: "not_related" }).distinct("path")
    const kept = approved.filter((l) => l.kept_violations?.includes(OLD_VALUE_LEFT_RULE)).map((l) => l.path)
    const record = await spineRepository.get(projectId)
    if (!record) return
    const spine = stripRecord(record)
    const hits = sweepOldValues(spine, replaced, new Set([...notRelated, ...kept]))
    if (!hits.length) return
    const findings = hits.map((h) => ({
      rule: "old_value_left",
      section_id: sectionOfElement(spine, h.path),
      target_id: h.path,
      block_ids: [],
      message: `${pathLabel(h.path)} còn ghi giá trị cũ ${h.values.map((v) => `“${v}”`).join(", ")} ở ${h.places.join(", ")} sau ${cr.cr_id}. Sửa cho khớp hoặc giữ nguyên nếu con số này mang nghĩa khác`
    }))
    const ops = findingOps(spine, findings, "cr_old_value_left")
    if (!ops.length) return
    await applyTransaction(projectId, { base_version: record.spine_version, ops, by: cr.cr_id, reason: `${cr.cr_id}: còn giá trị cũ`, step_id: null })
  } catch (err) {
    console.warn(`[C-7] ${cr.cr_id}: quét giá trị cũ còn sót lỗi - bỏ qua`, err)
  }
}

/**
 * BPMN 3.14: ghi xong thì bản nháp minor phải khớp dữ liệu — kể cả hình. Mode 1 v3 không còn step vẽ lại, nên sau khi
 * Spine đã ghi: vẽ lại hình lệch (PlantUML không có mặt ⇒ bỏ qua, cờ `diagram_stale` báo), có hình đổi thì in lại file
 * version từ Spine mới nhất để nhúng hình mới. Lỗi chỉ ghi log — Spine đã ghi, không huỷ bản ghi.
 */
const redrawDiagrams = async (
  projectId: string,
  crId: string,
  userId: string,
  projectName: string,
  version: string,
  refs: { file: string; tracked: string | null },
  tracked: (file: Buffer) => Promise<string | null>,
  newScreenIds: readonly string[] = []
): Promise<void> => {
  // Màn mới vẽ trước bằng model (`layoutRenderDeps`); lượt vẽ lại toàn bộ sau đó thấy hash khớp nên giữ nguyên hình đó.
  // FLF-387: model gọi bằng user ghi CR — mã CR không phải user id (giữ credit hỏng ⇒ màn mới rơi về bảng function)
  const fresh = newScreenIds.length ? await renderChangedIfAvailable(projectId, newScreenIds, { by: crId, userId, step_id: null, deps: layoutRenderDeps() }) : null
  // TechMart 11/11: màn có sẵn mà CR đổi dữ liệu (hình lệch) cũng vẽ lại bằng model như màn mới — dep mặc định không gọi
  // model nên wireframe bị thay bằng bảng chức năng dự phòng
  const drawn = await renderAllIfAvailable(projectId, { by: crId, userId, step_id: null, deps: layoutRenderDeps() })
  if (![fresh, drawn].some((r) => r && (r.rendered.length || r.removed.length))) return
  try {
    const latest = stripRecord((await spineRepository.get(projectId))!)
    const stored = await DocVersion.findOne({ projectId, version }).lean()
    const templateSource = stored?.template_source ?? null
    const buffer = await renderVersionFile(projectId, projectName, latest, { version, stampSource: "cr_revision", templateSource, ...(stored?.record_snapshot ? { recordChanges: stored.record_snapshot } : {}) })
    const redone = await docFileStore().save(buffer, { projectId, kind: "version", name: version })
    const redoneTracked = await tracked(buffer)
    await DocVersion.updateOne({ projectId, version }, { $set: { file_ref: redone, tracked_file_ref: redoneTracked, spine_snapshot: latest } })
    await docFileStore().remove(refs.file)
    if (refs.tracked) await docFileStore().remove(refs.tracked)
  } catch (err) {
    console.warn(`[C-7] ${crId}: đã vẽ lại hình nhưng in lại ${version} lỗi - file version giữ hình cũ`, err)
  }
}

/** BPMN 3.14 (T6/T7): bản có đánh dấu so với version trước, lưu riêng. Lỗi ⇒ `null` — ghi CR không phụ thuộc bản này. */
const saveTracked = async (
  projectId: string,
  crId: string,
  author: string,
  prevRef: string,
  file: Buffer,
  version: string,
  comments: readonly TrackedComment[],
  date: Date,
  contentOnly = false
): Promise<string | null> => {
  try {
    const out = await buildTrackedDocx(await docFileStore().load(prevRef), file, { author, date }, comments, { contentOnly })
    return await docFileStore().save(out.data, { projectId, kind: "version", name: `${version}_tracked` })
  } catch (err) {
    console.warn(`[C-7] ${crId}: dựng bản có đánh dấu của ${version} lỗi - chỉ còn bản sạch`, err)
    return null
  }
}

// ─── đường ghi riêng của đổi mẫu (FLF-466: không còn CR giả) ──

/**
 * Người ghi của Change do đổi mẫu sinh ra là `system_change:<migrationId>` (`systemChangeActor`) — không phải CR, không có vị trí / nhóm / duyệt.
 * Mọi ghi Spine vẫn đi qua op engine; client không tạo được nguồn này.
 */

export interface TemplateMigrationWriteInput {
  /** `system_change:<migrationId>` (`systemChangeActor`). */
  by: string
  /** Id lô (bắt đầu bằng tiền tố `template-migration:`) — nhận ra Change của lần đổi mẫu và biết bước đã ghi chưa. */
  txn: string
  reason: string
  baseVersion?: number
}

/** Ghi các op của lần đổi mẫu (xoá mục riêng, thêm mục riêng trống, chữ đã dịch) trong MỘT lô: Spine tăng version đúng một lần. */
export const writeTemplateMigrationOps = async (projectId: string, ops: readonly Op[], input: TemplateMigrationWriteInput): Promise<number> => {
  const head = await spineRepository.versionHead(projectId)
  if (!head) throw new ApiError(404, "Không tìm thấy dữ liệu tài liệu của dự án.", spineRepository.SPINE_NOT_FOUND)
  if (!ops.length) return head.spine_version
  const applied = await applyTransaction(projectId, { base_version: input.baseVersion ?? head.spine_version, ops: [...ops], by: input.by, reason: input.reason, step_id: null, txn: input.txn })
  if (applied.changes.length) scheduleEmbeddingSync(projectId)
  return applied.spine_version
}

/** Đảo đúng các Change đã chọn (theo `before`) trong một lô mang `txn` của lần đổi mẫu. Change đã bị ghi đè sau đó ⇒ op engine từ chối (`revert_conflict`). */
export const revertTemplateMigrationChanges = async (projectId: string, changes: Change[], input: Pick<TemplateMigrationWriteInput, "by" | "txn" | "baseVersion">): Promise<number> => {
  if (!changes.length) return (await spineRepository.versionHead(projectId))?.spine_version ?? 0
  const applied = await revertChanges(projectId, changes, { by: input.by, txn: input.txn, ...(input.baseVersion !== undefined ? { base_version: input.baseVersion } : {}) })
  scheduleEmbeddingSync(projectId)
  return applied.spine_version
}
