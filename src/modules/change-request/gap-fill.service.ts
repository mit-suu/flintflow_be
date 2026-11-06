/**
 * FLF-382 (luồng B — có sẵn · mẫu cố định): một nút "Hoàn thiện". Còn mục trống ⇒ chốt 0.1 đúng phần khách viết, rồi tự mở
 * CR "Bổ sung mục còn thiếu" (`kind = gap_fill`) và chạy C-2 — AI hỏi, AI điền, BA xác nhận (C-6) ⇒ 0.2.
 * - Finalize đánh dấu `ImportedDocument.gap_fill_requested` (mục còn thiếu lúc bấm "Hoàn thiện").
 * - Job kiểm tra 1.11–1.12 xong (trước `checking ⇒ gap_review`) tạo CR — idempotent theo import: job chạy lại không tạo trùng.
 * - `POST …/change-requests/gap-fill`: mở lại (CR bổ sung đang mở) hoặc tạo CR mới cho mục **hiện còn** thiếu (I-5 chạy lại).
 * Luồng A (tự do) và C (dự án mới) không đi qua đây.
 */

import mongoose from "mongoose"
import { ActionType } from "../../shared/ai/ai-action.types.js"
import { getActionCost } from "../../shared/ai/credit-reservation.service.js"
import { stripRecord } from "../import/check.service.js"
import type { IImportedDocument } from "../import/imported-document.model.js"
import { latestImport } from "../import/import.service.js"
import { Mode1Error } from "../import/mode1.errors.js"
import { fileSectionTitle, isFixedExistingProject, refreshTargetStructure } from "../import/target-structure.service.js"
import type { TargetStructure } from "../import/target-structure.js"
import { TemplateProfile, type LayoutEntry } from "../import/template-profile.model.js"
import { documentLanguageOf } from "../project/document-language.js"
import { Project } from "../project/project.model.js"
import * as spineRepository from "../spine/spine.repository.js"
import type { Spine } from "../spine/spine.types.js"
import { User } from "../user/user.model.js"
import { ChangeRequest, type IChangeRequest } from "./change-request.model.js"
import { createCr } from "./change-request.service.js"
import type { CrStatus } from "./change-request.state.js"
import { fillableGapSections, gapFillBatches, gapFillLocations, gapFillRequestText, gapSectionsContext, type GapSection } from "./gap-fill.js"
import { templateGuidanceBySection } from "./propose.service.js"

/** CR bổ sung coi như đã đóng — `POST …/gap-fill` tạo CR mới thay vì trả CR này. */
const CLOSED: readonly CrStatus[] = ["written", "cancelled", "rejected"]

const titlesOf = async (projectId: string, sectionIds: readonly string[]): Promise<GapSection[]> => {
  const profile = await TemplateProfile.findOne({ projectId }, { target_structure: 1, layout: 1 }).lean()
  const layout = (profile?.layout ?? null) as LayoutEntry[] | null
  return sectionIds.map((section_id) => ({ section_id, title: fileSectionTitle(section_id, profile?.target_structure ?? null, layout) }))
}

/** Tiêu đề (theo file khách) của mục trong `gap_sections` — cho DTO CR. */
export const gapSectionTitles = async (projectId: string, crs: readonly Pick<IChangeRequest, "gap_sections">[]): Promise<Map<string, string>> => {
  const ids = [...new Set(crs.flatMap((c) => c.gap_sections ?? []))]
  if (!ids.length) return new Map()
  return new Map((await titlesOf(projectId, ids)).map((s) => [s.section_id, s.title]))
}

const requesterName = async (userId: string): Promise<string> => {
  const user = await User.findById(userId, { name: 1, email: 1 }).lean()
  return user?.name?.trim() || user?.email?.trim() || "FlintFlow"
}

/** Mục trống CR soạn được trên Spine hiện tại (`fillableGapSections`). */
const fillableNow = async (projectId: string, sectionIds: readonly string[]): Promise<string[]> => {
  const record = await spineRepository.get(projectId)
  return record ? fillableGapSections(stripRecord(record), sectionIds) : []
}

/** Tạo CR bổ sung (trạng thái `draft`) cho `sectionIds`; lời yêu cầu theo tiêu đề file, ngôn ngữ tài liệu. */
const createGapFillCr = async (projectId: string, userId: string, importId: mongoose.Types.ObjectId, sectionIds: readonly string[]): Promise<IChangeRequest> => {
  const [sections, project, profile] = await Promise.all([
    titlesOf(projectId, sectionIds),
    Project.findById(projectId).lean(),
    TemplateProfile.findOne({ projectId }, { language: 1 }).lean()
  ])
  const lang = project ? documentLanguageOf(project, profile?.language) : "en"
  const text = gapFillRequestText(
    sections.map((s) => s.title),
    lang === "vi" ? "vi" : "en"
  )
  return createCr(
    projectId,
    userId,
    { ...text, source: { kind: "gap_report", ref: null, note: null }, requester: await requesterName(userId) },
    { kind: "gap_fill", gap_sections: [...sectionIds], origin_import_id: importId }
  )
}

/**
 * Bước kiểm tra 1.11–1.12 xong, ngay trước `checking ⇒ gap_review`: import có `gap_fill_requested` ⇒ tạo CR bổ sung (một
 * lần mỗi import — job chạy lại thấy CR đã có). Trả CR cần chạy C-2 (vừa tạo, hoặc lần trước tạo rồi mà chưa kịp làm rõ),
 * không có ⇒ `null`.
 */
export const prepareAutoGapFill = async (doc: IImportedDocument, userId: string): Promise<IChangeRequest | null> => {
  const sectionIds = doc.gap_fill_requested?.section_ids ?? []
  if (!sectionIds.length) return null
  const projectId = String(doc.projectId)
  const existing = await ChangeRequest.findOne({ projectId, kind: "gap_fill", origin_import_id: doc._id }).sort({ createdAt: 1 })
  if (existing) return existing.status === "draft" ? existing : null
  const fillable = await fillableNow(projectId, sectionIds)
  return fillable.length ? createGapFillCr(projectId, userId, doc._id as mongoose.Types.ObjectId, fillable) : null
}

/** C-2 của CR bổ sung — lỗi chỉ ghi log (CR vẫn mở, `POST …/clarify` / `resume` chạy lại được). */
export const startGapFillClarify = async (cr: IChangeRequest, userId: string): Promise<void> => {
  try {
    const { runClarify } = await import("./clarify.service.js")
    await runClarify(cr, userId)
  } catch (err) {
    console.warn(`[gap-fill] ${cr.cr_id}: làm rõ (C-2) lỗi — chạy lại bằng "Làm rõ"`, err)
  }
}

const openGapFillCr = async (projectId: string): Promise<IChangeRequest | null> =>
  ChangeRequest.findOne({ projectId, kind: "gap_fill", status: { $nin: CLOSED } }).sort({ createdAt: -1, _id: -1 })

/**
 * `POST …/change-requests/gap-fill`: CR bổ sung đang mở ⇒ trả nó (`created = false`); không có ⇒ I-5 chạy lại trên Spine
 * hiện tại, còn mục thiếu ⇒ tạo CR mới + C-2; không còn ⇒ 409 `NO_MISSING_SECTIONS`.
 */
export const requestGapFill = async (projectId: string, userId: string): Promise<{ cr: IChangeRequest; created: boolean }> => {
  const open = await openGapFillCr(projectId)
  if (open) {
    if (open.status === "draft") await startGapFillClarify(open, userId)
    return { cr: open, created: false }
  }
  if (!(await isFixedExistingProject(projectId))) {
    throw new Mode1Error("NO_MISSING_SECTIONS", "Chỉ dự án tải SRS có sẵn theo mẫu cố định mới có mục còn trống để soạn bổ sung.")
  }
  const imported = await latestImport(projectId)
  const structure = await refreshTargetStructure(projectId)
  const fillable = structure ? await fillableNow(projectId, structure.missing) : []
  if (!imported || !fillable.length) throw new Mode1Error("NO_MISSING_SECTIONS", "Tài liệu không còn mục nào trống — không có gì để soạn bổ sung.")
  const cr = await createGapFillCr(projectId, userId, imported._id as mongoose.Types.ObjectId, fillable)
  await startGapFillClarify(cr, userId)
  return { cr, created: true }
}

/** Sau C-6 của dự án luồng B: I-5 chạy lại trên Spine mới (mục vừa soạn ⇒ `present`). Lỗi chỉ ghi log. */
export const refreshAfterWrite = async (projectId: string): Promise<void> => {
  try {
    if (await isFixedExistingProject(projectId)) await refreshTargetStructure(projectId)
  } catch (err) {
    console.warn(`[gap-fill] cập nhật cấu trúc đích sau khi ghi lỗi (project ${projectId})`, err)
  }
}

/**
 * Hai field thêm vào `GET /import`: `gap_fill_cr_id` — CR bổ sung của import (đang mở trước, rồi mới nhất); và
 * `gap_fill_credit_estimate` — luồng B, `incomplete`, còn mục thiếu: (C-2 + C-4 + C-5) × số lô theo phần. Khác ⇒ `null`.
 */
export const gapFillImportFields = async (
  projectId: string,
  doc: IImportedDocument | null,
  structure: Pick<TargetStructure, "missing"> | null | undefined
): Promise<{ gap_fill_cr_id: string | null; gap_fill_credit_estimate: number | null }> => {
  if (!doc) return { gap_fill_cr_id: null, gap_fill_credit_estimate: null }
  const crs = await ChangeRequest.find({ projectId, kind: "gap_fill", origin_import_id: doc._id }, { cr_id: 1, status: 1, createdAt: 1 })
    .sort({ createdAt: -1, _id: -1 })
    .lean()
  const cr = crs.find((c) => !CLOSED.includes(c.status)) ?? crs[0] ?? null
  let estimate: number | null = null
  if (doc.status === "incomplete" && structure?.missing.length && (await isFixedExistingProject(projectId))) {
    const record = await spineRepository.get(projectId)
    const spine = record ? stripRecord(record) : null
    const groups = spine ? gapFillBatches(spine, gapFillLocations(spine, structure.missing)).length : 0
    // Không mục nào soạn được bằng CR ⇒ không có CR bổ sung ⇒ không tốn credit
    estimate = groups ? (await gapFillCreditPerGroup()) * groups : null
  }
  return { gap_fill_cr_id: cr?.cr_id ?? null, gap_fill_credit_estimate: estimate }
}

/** Credit một lô của CR bổ sung: C-2 làm rõ + C-4 đề xuất + C-5 kiểm (bảng giá hiện hành). */
export const gapFillCreditPerGroup = async (): Promise<number> => {
  const costs = await Promise.all([ActionType.CR_CLARIFY, ActionType.CR_PROPOSE, ActionType.CR_CONSISTENCY].map((a) => getActionCost(a)))
  return costs.reduce((a, b) => a + b, 0)
}

/**
 * Ngữ cảnh mục trống cho prompt C-2 / C-4 của CR bổ sung (`gapSectionsContext`): tiêu đề theo file, hướng dẫn của mẫu
 * (`heading_map[].guidance` + `layout[].template_guidance` + chữ hướng dẫn trong mục riêng), nội dung nên có 29148, skill.
 * CR thường ⇒ `""` (khối `{{#if gap_sections}}` của skill bị bỏ).
 */
export const gapContextFor = async (cr: Pick<IChangeRequest, "projectId" | "kind" | "gap_sections">, spine: Spine): Promise<string> => {
  if (cr.kind !== "gap_fill" || !cr.gap_sections?.length) return ""
  const projectId = String(cr.projectId)
  const profile = await TemplateProfile.findOne({ projectId }, { heading_map: 1, layout: 1, target_structure: 1 }).lean()
  const layout = (profile?.layout ?? []) as LayoutEntry[]
  const sections = cr.gap_sections.map((section_id) => ({ section_id, title: fileSectionTitle(section_id, profile?.target_structure ?? null, layout) }))
  const layoutGuidance = new Map<string, string[]>()
  for (const l of layout) if (l.template_guidance?.length) layoutGuidance.set(l.section_id, [...(layoutGuidance.get(l.section_id) ?? []), ...l.template_guidance])
  return gapSectionsContext(spine, sections, templateGuidanceBySection(profile ?? null), layoutGuidance)
}
