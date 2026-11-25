/**
 * Change request mode 1 — phần lõi: tạo (C-1, nút 3.1), đọc, chuyển trạng thái, nộp (3.11), sửa lại / đóng
 * (3.12–3.13), huỷ (3.10, UC-53). FLF-171, plan §6 2E.
 * AI (C-2, C-4, C-5) ở `clarify` / `propose` / `verify`; tìm vị trí + khoá ở `impact`; duyệt + ghi ở `decision` / `write`.
 */

import mongoose from "mongoose"
import { latestDocVersion } from "../doc-version/doc-version.service.js"
import { stripRecord } from "../import/check.service.js"
import { loadLayout, titleOfSection } from "../import/gap-report.service.js"
import { hasBaseline } from "../import/import.state.js"
import { latestImport, transitionImport } from "../import/import.service.js"
import { Mode1Error } from "../import/mode1.errors.js"
import { toIso } from "../import/mode1.http.js"
import { clipMaterialText, formatCrId, formatMaterialId, type CrSourceKind } from "./change-request.constants.js"
import type { ChangeRequestDetail, CreateChangeRequest, PendingSection } from "./change-request.dto.js"
import { ChangeRequest, CrCounter, type CrSeed, type IChangeRequest } from "./change-request.model.js"
import { CR_OPEN_STATUSES, CR_STATUSES, CR_STATUS_LABELS, assertTransition, isTerminal, type CrStatus } from "./change-request.state.js"
import { seedFromFlags } from "./flag-seed.js"
import { ChangeGroup } from "./change-group.model.js"
import { ChangeLocation, type LocationProposal } from "./change-location.model.js"
import { regroup } from "./group.service.js"
import { writeApproved } from "./write.service.js"
import { assertPackageNotPending } from "../doc-version/review-package.service.js"
import * as spineRepository from "../spine/spine.repository.js"
import { notify } from "../notification/notification.service.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { unlockPaths } from "./lock.service.js"
import { checkBeforeWrite, othersPending, pendingSections, userName } from "./concurrent-edit.js"
import { changedProjectFields, elementText, locationDisplay } from "./location-display.js"
import { LARGE_CR_LOCATIONS, previewAfter, proposeEstimate, type ProposeEstimate } from "./propose.service.js"
import { hasPendingWarning, recheckBeforeWrite } from "./verify.service.js"
import { getActionCost } from "../../shared/ai/credit-reservation.service.js"
import { ActionType } from "../../shared/ai/ai-action.types.js"
import { PROJECT_PATH, addedElements, currentText, isArrayPath, opElement, projectSectionOf, valueText } from "./spine-location.js"
import { peekPreview } from "../spine/change.service.js"
import { markPreviewAsCr } from "../spine/change-transcript.js"

// ─── đọc ─────────────────────────────────────────────────────────

export const requireCr = async (projectId: string, crId: string): Promise<IChangeRequest> => {
  const cr = await ChangeRequest.findOne({ projectId, cr_id: crId })
  if (!cr) throw new Mode1Error("CR_NOT_FOUND", `Không tìm thấy ${crId}`)
  return cr
}

export const assertCrStatus = (cr: IChangeRequest, allowed: readonly CrStatus[], to: CrStatus): void => {
  if (!allowed.includes(cr.status)) {
    throw new Mode1Error("CR_INVALID_TRANSITION", `${cr.cr_id} đang ở bước "${CR_STATUS_LABELS[cr.status] ?? cr.status}", chưa làm được thao tác này`, { status: cr.status, to, allowed })
  }
}

export const transitionCr = async (cr: IChangeRequest, to: CrStatus): Promise<void> => {
  if (cr.status === to) return
  assertTransition(cr.status, to)
  cr.status = to
  await cr.save()
}

const toCrDto = (cr: IChangeRequest): ChangeRequestDetail["change_request"] => ({
  cr_id: cr.cr_id,
  project_id: String(cr.projectId),
  title: cr.title,
  description: cr.description,
  source: { kind: cr.source.kind, ref: cr.source.ref ?? null, note: cr.source.note ?? null },
  requester: cr.requester,
  status: cr.status,
  paused: cr.paused ? { reason: cr.paused.reason, at: toIso(cr.paused.at)! } : null,
  clarifications: cr.clarifications.map((c) => ({
    round: c.round,
    questions: [...c.questions],
    answers: [...c.answers],
    suggestions: c.questions.map((_, i) => [...(c.suggestions?.[i] ?? [])])
  })),
  base_doc_version: cr.base_doc_version,
  result_doc_version: cr.result_doc_version ?? null,
  created_by: String(cr.created_by),
  submitted_at: toIso(cr.submitted_at),
  decided_by: cr.decided_by ? String(cr.decided_by) : null,
  closed_reason: cr.closed_reason ?? null,
  flag_ids: [...(cr.flag_ids ?? [])],
  seed: cr.seed ? { instruction: cr.seed.instruction ?? null, ops: [...cr.seed.ops], targets: [...cr.seed.targets] } : null,
  materials: (cr.materials ?? []).map((m) => ({
    material_id: m.material_id,
    kind: m.kind,
    name: m.name,
    text: m.text,
    truncated: m.truncated,
    round: m.round,
    added_at: toIso(m.added_at)!
  })),
  missing_info: [...(cr.missing_info ?? [])],
  withdraw_suggested: cr.withdraw_suggested ?? false,
  amendments: (cr.amendments ?? []).map((a) => ({ text: a.text, at: toIso(a.at)! })),
  created_at: toIso(cr.createdAt)!,
  updated_at: toIso(cr.updatedAt)!
})

export const pendingQuestions = (cr: IChangeRequest): string[] => {
  if (cr.status !== "awaiting_answers") return []
  const last = cr.clarifications[cr.clarifications.length - 1]
  return last && last.answers.length === 0 ? [...last.questions] : []
}

const parseJson = (text: string | null | undefined): unknown => {
  try {
    return text ? JSON.parse(text) : undefined
  } catch {
    return undefined
  }
}

/**
 * `old_text` / `new_text` gửi FE. Vị trí "thêm mới" (`arr[]`) lưu trước FLF-308 chép cả mảng hai bên (vài chục–trăm KB
 * mỗi vị trí) ⇒ rút về như bản ghi mới: trước `"[]"`, sau = chỉ phần tử thêm. Không đổi DB (C-5 vẫn so `old_text` cũ).
 */
export const shownTexts = (path: string, p: Pick<LocationProposal, "old_text" | "new_text" | "base_hash">): { old_text: string; new_text: string | null } => {
  if (!isArrayPath(path) || p.base_hash || p.old_text === "[]") return { old_text: p.old_text, new_text: p.new_text ?? null }
  const newText = p.new_text ?? null
  return { old_text: "[]", new_text: newText === null ? null : valueText(addedElements(parseJson(p.old_text), parseJson(newText))) }
}

export const toDetail = async (cr: IChangeRequest): Promise<ChangeRequestDetail> => {
  const [locations, groups, record, layout] = await Promise.all([
    ChangeLocation.find({ projectId: cr.projectId, cr_id: cr.cr_id }).sort({ location_id: 1 }).lean(),
    ChangeGroup.find({ projectId: cr.projectId, cr_id: cr.cr_id }).sort({ group_id: 1 }).lean(),
    spineRepository.get(String(cr.projectId)),
    loadLayout(String(cr.projectId))
  ])
  const spine = record ? stripRecord(record) : null
  const pending = await othersPending(cr.projectId, cr.cr_id, locations.map((l) => l.path))
  const asText = (json: string | null | undefined) => (json ? elementText(parseJson(json)) : "")
  return {
    change_request: { ...toCrDto(cr), created_by_name: (await userName(String(cr.created_by))) ?? null },
    locations: locations.map((l) => {
      // Lỗi #6: vị trí `project` lưu `fixed:1` từ lúc tìm — có đề xuất thì biết field nào đổi ⇒ đúng mục (vd `slot:goals`)
      const section_id =
        l.path === PROJECT_PATH ? (projectSectionOf(changedProjectFields(l.proposal, spine?.project), layout) ?? l.section_id) : l.section_id
      return {
        location_id: l.location_id,
        path: l.path,
        section_id,
        section_title: spine && section_id !== "misc" ? titleOfSection(spine, section_id, layout) : "",
        current_text: spine ? currentText(spine, l.path) : "",
        found_by: [...l.found_by],
        entity_paths: [...l.entity_paths],
        vector_score: l.vector_score ?? null,
        owner_step: l.owner_step ?? null,
        conclusion: l.conclusion ?? null,
        reason: l.reason ?? null,
        proposal: l.proposal
          ? { ...shownTexts(l.path, l.proposal), comment_text: l.proposal.comment_text ?? null, spine_ops: [...(l.proposal.spine_ops ?? [])], assumptions: [...(l.proposal.assumptions ?? [])] }
          : null,
        manual: l.manual,
        redo_count: l.redo_count,
        verify: l.verify
          ? {
              code_ok: l.verify.code_ok,
              violations: l.verify.violations.map((v) => ({ rule: v.rule, message: v.message, ...(v.path ? { path: v.path } : {}) })),
              ai_flags: l.verify.ai_flags.map((f) => ({ rule: f.rule, message: f.message })),
              at: toIso(l.verify.at)!
            }
          : null,
        group_id: l.group_id ?? null,
        warning: l.warning ? { text: l.warning.text, reason: l.warning.reason } : null,
        kept_intent: l.kept_intent ?? false,
        kept_violations: [...(l.kept_violations ?? [])],
        // Đề xuất cũ lưu `new_text = null` (chạy khô từng hỏng) ⇒ tính lại chữ "sau" từ op để người dùng thấy sẽ đổi gì
        display: locationDisplay(
          spine,
          l.path,
          l.conclusion ?? null,
          l.proposal && l.proposal.new_text === null && l.conclusion === "edit" && spine && l.proposal.spine_ops?.length
            ? { ...l.proposal, new_text: previewAfter(spine, l.path, l.proposal.spine_ops) }
            : (l.proposal ?? null)
        ),
        conflict: l.conflict
          ? {
              at_proposal: asText(l.conflict.at_proposal_text),
              current: asText(l.conflict.current_text),
              proposal: l.conflict.proposal_text ? asText(l.conflict.proposal_text) : null,
              changed_by: l.conflict.changed_by,
              changed_at: toIso(l.conflict.changed_at),
              proposed_at: toIso(l.conflict.proposed_at),
              question: l.conflict.question ?? null
            }
          : null,
        others_pending: pending.get(l.path) ?? []
      }
    }),
    groups: groups.map((g) => ({
      group_id: g.group_id,
      title: g.title,
      location_ids: [...g.location_ids],
      decision: g.decision,
      reason: g.reason ?? null,
      decided_by: g.decided_by ? String(g.decided_by) : null,
      decided_at: toIso(g.decided_at)
    })),
    pending_questions: pendingQuestions(cr),
    propose_estimate: await estimateOf(cr, spine, locations)
  }
}

/**
 * C-3 liệt kê đủ vị trí (không cắt trần) ⇒ CR lớn gọi nhiều lô C-4. Trước khi chạy C-4 (CR còn ở "xem phạm vi") mà vượt
 * `LARGE_CR_LOCATIONS` vị trí thì báo tổng credit ước tính (số lô × giá một lô); còn lại `null`.
 */
const estimateOf = async (cr: IChangeRequest, spine: ReturnType<typeof stripRecord> | null, locations: readonly { path: string }[]): Promise<ProposeEstimate | null> => {
  if (cr.status !== "impact_review" || !spine || locations.length <= LARGE_CR_LOCATIONS) return null
  const docs = await ChangeLocation.find({ projectId: cr.projectId, cr_id: cr.cr_id })
  return proposeEstimate(spine, docs, await getActionCost(ActionType.CR_PROPOSE))
}

export const listCrs = async (projectId: string, status?: CrStatus): Promise<ChangeRequestDetail["change_request"][]> => {
  const filter: Record<string, unknown> = { projectId }
  if (status) filter.status = status
  const crs = await ChangeRequest.find(filter).sort({ createdAt: -1, _id: -1 })
  return crs.map(toCrDto)
}

/** BF §3.2: mục nào của tài liệu đang có bản sửa chưa xác nhận (CR chưa đóng), ai giữ — cho tài liệu đang mở. */
export const listPendingSections = async (projectId: string): Promise<PendingSection[]> => {
  const rows = await pendingSections(projectId)
  if (!rows.length) return []
  const [record, layout] = await Promise.all([spineRepository.get(projectId), loadLayout(projectId)])
  const spine = record ? stripRecord(record) : null
  return rows.map((r) => ({ ...r, title: spine ? titleOfSection(spine, r.section_id, layout) : r.section_id }))
}

// ─── C-1 tạo ─────────────────────────────────────────────────────

/** Bản xem trước ⇒ gợi ý của CR: lệnh, op, phần tử bị op chạm. Hết hạn / của người khác ⇒ `null`. */
export const seedFromPreview = (projectId: string, userId: string, previewId: string): CrSeed | null => {
  const preview = peekPreview(projectId, previewId, userId)
  if (!preview) return null
  const targets = [...new Set(preview.ops.map((op) => opElement(op.path)).filter((p): p is string => !!p))]
  return { instruction: preview.instruction, ops: preview.ops.map((op) => ({ ...op }) as Record<string, unknown>), targets }
}

/** Gợi ý của CR: bản xem trước và / hoặc nhóm cờ (đích gộp, bỏ trùng). Không có cả hai ⇒ `null`. */
const mergeSeeds = (preview: CrSeed | null, flags: CrSeed | null): CrSeed | null =>
  preview && flags ? { ...preview, targets: [...new Set([...preview.targets, ...flags.targets])] } : (preview ?? flags)

/** Id cờ đang thuộc CR chưa kết thúc của project — hàng việc chờ quyết bỏ các cờ này (FLF-445). */
export const flagIdsInOpenCrs = async (projectId: string): Promise<Set<string>> => {
  const terminal = CR_STATUSES.filter(isTerminal)
  const ids: string[] = await ChangeRequest.distinct("flag_ids", { projectId, status: { $nin: terminal }, "flag_ids.0": { $exists: true } })
  return new Set(ids)
}

/**
 * BF §3.2 C-1: mỗi người một CR mở một lúc - người tạo đã có CR chưa kết thúc ⇒ 409 `CR_OWN_OPEN` (`meta.cr_id` = CR đó để
 * FE mở lại). Chỉ áp cho CR do chính người này tạo; CR của người khác không liên quan. `createCr` gọi khi
 * `enforceOwnOpen` (controller, hoàn tác); lô CR hệ thống tạo thay người dùng (rút yêu cầu từ tài liệu) không bật.
 */
export const assertNoOwnOpenCr = async (projectId: string, userId: string): Promise<void> => {
  const open = await ChangeRequest.findOne({ projectId, created_by: userId, status: { $in: CR_OPEN_STATUSES } }, { cr_id: 1, title: 1 }).sort({ createdAt: 1 }).lean()
  if (open) {
    throw new ApiError(409, `Bạn đang có ${open.cr_id} chưa xong - hoàn tất hoặc huỷ ${open.cr_id} trước khi tạo change request mới.`, "CR_OWN_OPEN", { cr_id: open.cr_id, title: open.title })
  }
}

/** Đầu vào tạo CR: như `CreateChangeRequest` nhưng nguồn nhận cả loại hệ thống tự đặt (`revert`) mà client không tạo trực tiếp được. */
export type CreateCrInput = Omit<CreateChangeRequest, "source"> & { source: { kind: CrSourceKind; ref: string | null; note: string | null } }

export interface CreateCrOptions {
  /** Người tạo chỉ được một CR mở: có CR chưa xong ⇒ `409 CR_OWN_OPEN`. Đường người dùng tạo CR bật; lô hệ thống tạo thay họ thì không. */
  enforceOwnOpen?: boolean
}

export const createCr = async (projectId: string, userId: string, body: CreateCrInput, options: CreateCrOptions = {}): Promise<IChangeRequest> => {
  const record = await spineRepository.get(projectId)
  // FLF-330 C-7: gói đang chờ Lead ⇒ bản nháp khoá, không mở CR mới
  assertPackageNotPending(record?.baseline_submission)
  const imported = await latestImport(projectId)
  const version = await latestDocVersion(projectId)
  if (!imported || !hasBaseline(imported.status) || !version) {
    throw new Mode1Error("CR_REQUIRES_BASELINE", "Chưa có bản gốc của tài liệu - hoàn tất nhập tài liệu trước khi tạo change request")
  }
  if (options.enforceOwnOpen) await assertNoOwnOpenCr(projectId, userId)
  // FLF-445: kiểm nhóm cờ trước khi lấy số CR (lỗi thì không tốn mã CR)
  if (body.flag_ids?.length && !record) throw new ApiError(404, "Không tìm thấy dữ liệu tài liệu của dự án.", spineRepository.SPINE_NOT_FOUND)
  const fromFlags = body.flag_ids?.length && record ? seedFromFlags(stripRecord(record), body.flag_ids) : null
  const counter = await CrCounter.findOneAndUpdate({ projectId }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: "after" })
  const cr = await ChangeRequest.create({
    projectId,
    cr_id: formatCrId(counter.seq),
    title: body.title,
    description: body.description,
    source: body.source,
    requester: body.requester,
    seed: mergeSeeds(body.preview_id ? seedFromPreview(projectId, userId, body.preview_id) : null, fromFlags?.seed ?? null),
    flag_ids: fromFlags?.flagIds ?? [],
    materials: (body.materials ?? []).map((m, i) => ({ ...clipMaterialText(m.text), material_id: formatMaterialId(i + 1), kind: "text", name: m.name, round: 0, added_at: new Date() })),
    status: "draft",
    base_doc_version: version.version,
    created_by: userId
  })
  if (imported.status === "gap_review" || imported.status === "delivered") await transitionImport(imported, "change_requested")
  // FLF-318: tin bản xem trước trong chat ⇒ "đã tạo CR-…" (lỗi chỉ ghi log — CR đã tạo)
  if (body.preview_id) {
    await markPreviewAsCr(projectId, body.preview_id, cr.cr_id).catch((err: unknown) => console.warn(`[CR] ${cr.cr_id}: đánh dấu tin bản xem trước lỗi`, err))
  }
  return cr
}

// ─── 3.11 nộp, 3.12–3.13 sửa lại / đóng, 3.10 huỷ ───────────────

/**
 * BF §3.2 / spec UC-45 A6: đề xuất chưa xác nhận **treo ở người yêu cầu** — người khác không làm rõ, không cho AI soạn, không
 * kiểm, không xác nhận hộ (họ không có bối cảnh, và người xác nhận là người đứng tên thay đổi). Người khác chỉ thấy
 * "<ai> có bản sửa chưa xác nhận ở mục này" (`listPendingSections`).
 */
export const assertRequester = async (cr: IChangeRequest, userId: string): Promise<void> => {
  if (String(cr.created_by) === String(userId)) return
  const who = (await userName(String(cr.created_by))) ?? cr.requester
  throw new ApiError(403, `Đề xuất này đang treo ở ${who} - chỉ người đó xác nhận được (người xác nhận đứng tên thay đổi).`, "CR_NOT_REQUESTER")
}

/**
 * C-6 (FLF-330, business-flow §3.2): BA **xác nhận** ⇒ Code kiểm lại trên nội dung hiện tại rồi ghi Track Changes vào bản
 * nháp chung **ngay** (tác giả = mã CR) — không chờ Lead, không tạo baseline. Mọi group của CR được ghi nhận "đã duyệt"
 * bởi chính người xác nhận; vị trí `not_related` (BA bỏ riêng) không ghi. Lead duyệt **cả gói** ở C-7 (`review-package`).
 */
export const submitCr = async (cr: IChangeRequest, userId: string): Promise<void> => {
  assertCrStatus(cr, ["ready_to_submit"], "written")
  await assertRequester(cr, userId)
  const unconcluded = await ChangeLocation.find({ projectId: cr.projectId, cr_id: cr.cr_id, conclusion: null }).distinct("location_id")
  if (unconcluded.length) {
    throw new Mode1Error("CR_LOCATION_UNCONCLUDED", `Còn ${unconcluded.length} vị trí chưa có kết luận`, { location_ids: unconcluded })
  }
  // `regroup` chỉ gom vị trí `edit`/`comment`. Mọi vị trí `not_related` ⇒ 0 group ⇒ vào `in_review` mà không có gì
  // để duyệt: CR kẹt, màn duyệt trống không nút (gặp thật 2026-09-20). Chặn ngay ở đây, chỉ hai lối đi thật sự.
  const decidable = await ChangeLocation.countDocuments({ projectId: cr.projectId, cr_id: cr.cr_id, conclusion: { $in: ["edit", "comment"] } })
  if (!decidable) {
    throw new Mode1Error(
      "CR_NOTHING_TO_APPROVE",
      "Mọi vị trí đều kết luận \"không liên quan\" - không có thay đổi nào để duyệt. Sửa kết luận ở vị trí cần đổi, hoặc huỷ change request.",
      { location_count: await ChangeLocation.countDocuments({ projectId: cr.projectId, cr_id: cr.cr_id }) }
    )
  }
  const record = await spineRepository.get(String(cr.projectId))
  if (!record) throw new ApiError(404, "Không tìm thấy dữ liệu tài liệu của dự án.", spineRepository.SPINE_NOT_FOUND)
  assertPackageNotPending(record.baseline_submission)
  // BF §3.2 C-4: AI đã cảnh báo mà BA chưa chọn "Vẫn làm" hay bỏ thì chưa xác nhận được
  const warned = (await ChangeLocation.find({ projectId: cr.projectId, cr_id: cr.cr_id, warning: { $ne: null } })).filter(hasPendingWarning).map((l) => l.location_id)
  if (warned.length) {
    throw new ApiError(409, `Còn ${warned.length} chỗ AI đã cảnh báo - chọn "Vẫn làm" hoặc bỏ chỗ đó trước khi xác nhận.`, "CR_WARNING_PENDING", { location_ids: warned })
  }

  // FLF-375 — "Hai người sửa cùng lúc": kiểm lại từng chỗ trên nội dung hiện tại trước khi ghi
  const check = await checkBeforeWrite(cr, await ChangeLocation.find({ projectId: cr.projectId, cr_id: cr.cr_id }), stripRecord(record))
  if (check.conflicts) {
    // Chữ cũ không còn ở chỗ người khác vừa sửa ⇒ không ghi gì; người dùng xem so sánh 3 cột rồi quyết
    await transitionCr(cr, "manual_fix")
    return
  }
  if (check.same && !(await ChangeLocation.countDocuments({ projectId: cr.projectId, cr_id: cr.cr_id, conclusion: { $in: ["edit", "comment"] } }))) {
    // Mọi chỗ đã được người khác sửa giống hệt đề xuất ⇒ đóng, không ghi
    cr.closed_reason = "Mọi chỗ của change request đã được người khác sửa giống đề xuất - không còn gì để ghi"
    await transitionCr(cr, "cancelled")
    return
  }

  // C-6 kiểm lại đủ: Spine có thể đã đổi từ lúc kiểm C-5 (CR khác ghi trước, sửa ở chỗ khác) ⇒ chạy khô + so cờ đỏ trước / sau
  // trên nội dung hiện tại. Có lỗi mới (trừ lỗi BA đã giữ theo ý mình) ⇒ về "Cần bạn quyết", không ghi gì.
  const locations = await ChangeLocation.find({ projectId: cr.projectId, cr_id: cr.cr_id })
  const again = await recheckBeforeWrite(cr, locations, stripRecord(record))
  if (again.size) {
    const at = new Date()
    for (const l of locations) {
      const vs = again.get(l.location_id)
      if (!vs) continue
      l.verify = { code_ok: false, violations: vs, ai_flags: l.verify?.ai_flags ?? [], at }
      await l.save()
    }
    await transitionCr(cr, "manual_fix")
    return
  }

  await regroup(cr)
  cr.submitted_at = new Date()
  const approved = await ChangeLocation.find({ projectId: cr.projectId, cr_id: cr.cr_id, conclusion: { $in: ["edit", "comment"] } })
  const written = await writeApproved(cr, userId, approved, record.spine_version)
  const decidedBy = new mongoose.Types.ObjectId(userId)
  await ChangeGroup.updateMany({ projectId: cr.projectId, cr_id: cr.cr_id }, { $set: { decision: "approved", reason: "BA xác nhận, ghi vào bản nháp", decided_by: decidedBy, decided_at: new Date() } })
  cr.result_doc_version = written
  cr.decided_by = decidedBy
  await transitionCr(cr, "written")
  void notify(userId, {
    type: "change_request_written",
    title: `${cr.cr_id} đã ghi vào bản nháp`,
    body: `Thay đổi "${cr.title}" đã ghi vào bản nháp chung (bản ${written}). Gửi Lead duyệt cả gói khi muốn phát hành.`,
    meta: { cr_id: cr.cr_id, cr_title: cr.title, result_doc_version: written }
  })
}

/** Mọi group bị từ chối ⇒ khoá lại phần tử, bỏ đề xuất cũ, về đề xuất (3.6). */
export const reviseCr = async (cr: IChangeRequest): Promise<void> => {
  assertCrStatus(cr, ["in_review"], "proposing")
  const groups = await ChangeGroup.find({ projectId: cr.projectId, cr_id: cr.cr_id })
  if (groups.some((g) => g.decision !== "rejected")) {
    throw new Mode1Error("CR_INVALID_TRANSITION", "Chỉ sửa lại được khi mọi nhóm thay đổi đã bị từ chối", { status: cr.status, to: "proposing", allowed: [] })
  }
  await ChangeGroup.deleteMany({ projectId: cr.projectId, cr_id: cr.cr_id })
  await ChangeLocation.updateMany(
    { projectId: cr.projectId, cr_id: cr.cr_id },
    { $set: { conclusion: null, reason: null, proposal: null, manual: false, redo_count: 0, verify: null, group_id: null } }
  )
  cr.submitted_at = null
  await transitionCr(cr, "proposing")
}

export const closeCr = async (cr: IChangeRequest, userId: string, reason: string): Promise<void> => {
  assertCrStatus(cr, ["in_review"], "rejected")
  cr.closed_reason = reason
  cr.decided_by = new mongoose.Types.ObjectId(userId)
  await transitionCr(cr, "rejected")
  await unlockPaths(cr.projectId, cr.cr_id)
}

/** UC-48 (AC-48.2): chỉ người tạo CR hoặc Lead huỷ được; Analyst huỷ CR của người khác ⇒ từ chối. */
export const cancelCr = async (cr: IChangeRequest, reason: string, actor: { userId: string; role?: string }): Promise<void> => {
  if (String(cr.created_by) !== String(actor.userId) && actor.role !== "lead") {
    const who = (await userName(String(cr.created_by))) ?? cr.requester
    throw new ApiError(403, `Chỉ ${who} (người tạo) hoặc Lead huỷ được ${cr.cr_id}.`, "CR_NOT_REQUESTER")
  }
  if (isTerminal(cr.status)) assertTransition(cr.status, "cancelled")
  cr.closed_reason = reason
  cr.paused = null
  await transitionCr(cr, "cancelled")
  await unlockPaths(cr.projectId, cr.cr_id)
}
