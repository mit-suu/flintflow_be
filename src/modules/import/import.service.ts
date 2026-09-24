/**
 * Luồng import mode 1 phần tất định: upload + preflight (I-1, nút 1.1–1.3), tách + neo block (I-2, 1.5),
 * khớp template profile (I-3, 1.6) và xác nhận mapping (1.7). FLF-171, plan §6 2B.
 * Trích field (I-4) và finalize ở `extract.service.ts` / `finalize.service.ts` (2C).
 *
 * Bản ghi import mới nhất của project là bản đang hiệu lực. Trước khi có baseline, upload lại = bắt đầu lại
 * (block/profile/extraction của lần trước bị thay). Sau baseline phải dùng `/reupload` (UC-24).
 */

import { createHash } from "node:crypto"
import mongoose from "mongoose"
import { docFileStore } from "../doc-version/doc-file.store.js"
import { IMPORTED_DOC_VERSION } from "../doc-version/versioning.js"
import { Project } from "../project/project.model.js"
import { DocBlock } from "./doc-block.model.js"
import { ExtractionDraft } from "./extraction-draft.model.js"
import { needsConfirm } from "./import.constants.js"
import type { GetImportResponse, ImportedDocumentDto, MappingPatchRequest, ReviewField, TemplateProfileDto } from "./import.dto.js"
import { IMPORT_STATUS_LABELS, assertTransition, hasBaseline, type ImportStatus } from "./import.state.js"
import { ImportedDocument, type IImportedDocument } from "./imported-document.model.js"
import { Mode1Error } from "./mode1.errors.js"
import { toIso } from "./mode1.http.js"
import { parseDocument, type ParsedBlock } from "./parse.service.js"
import { preflightDocx } from "./preflight.service.js"
import { assignBlockSections, matchProfile, missingRequiredSections, needsMappingReview } from "./profile-match.service.js"
import { isKnownSectionId } from "./section-catalog.js"
import { TemplateProfile, type ITemplateProfile } from "./template-profile.model.js"

export interface UploadedFile {
  buffer: Buffer
  originalname: string
  size: number
}

// ─── DTO ─────────────────────────────────────────────────────────

export const toImportDto = (doc: IImportedDocument): ImportedDocumentDto => ({
  id: String(doc._id),
  project_id: String(doc.projectId),
  original_name: doc.original_name,
  size: doc.size,
  sha256: doc.sha256,
  status: doc.status,
  preflight: {
    status: doc.preflight.status,
    issues: doc.preflight.issues.map((i) => ({ code: i.code, message: i.message, location: i.location ? { block_ord: i.location.block_ord, text: i.location.text } : null }))
  },
  stamp: doc.stamp ? { project_id: doc.stamp.project_id, version: doc.stamp.version ?? null, source: doc.stamp.source ?? null } : null,
  confirmed_latest_at: toIso(doc.confirmed_latest_at),
  paused: doc.paused ? { reason: doc.paused.reason, at: toIso(doc.paused.at)! } : null,
  extract_cursor: doc.extract_cursor ?? null,
  created_at: toIso(doc.createdAt)!,
  updated_at: toIso(doc.updatedAt)!
})

export const toProfileDto = (p: ITemplateProfile): TemplateProfileDto => ({
  doc_version: p.doc_version,
  heading_map: p.heading_map.map((h) => ({
    block_id: h.block_id,
    heading_text: h.heading_text,
    section_id: h.section_id,
    confidence: h.confidence,
    detected_by: h.detected_by,
    confirmed: h.confirmed
  })),
  table_map: p.table_map.map((t) => ({
    block_id: t.block_id,
    column_index: t.column_index,
    header: t.header,
    field_path: t.field_path ?? null,
    confidence: t.confidence,
    confirmed: t.confirmed
  })),
  required_sections: [...p.required_sections],
  language: p.language,
  layout: (p.layout ?? []).map((l) => ({ order: l.order, heading_text: l.heading_text, level: l.level, section_id: l.section_id }))
})

// ─── trạng thái ──────────────────────────────────────────────────

/** Chuyển trạng thái (kiểm máy trạng thái) + đồng bộ `Project.import_state`. */
export const transitionImport = async (doc: IImportedDocument, to: ImportStatus): Promise<void> => {
  assertTransition(doc.status, to)
  doc.status = to
  await doc.save()
  await Project.updateOne({ _id: doc.projectId }, { import_state: to })
}

export const latestImport = async (projectId: string): Promise<IImportedDocument | null> =>
  ImportedDocument.findOne({ projectId }).sort({ createdAt: -1, _id: -1 })

/** Import đang hiệu lực đúng `importId`; bản ghi cũ (đã bị upload khác thay) ⇒ `IMPORT_INVALID_STATE`. */
export const requireImport = async (projectId: string, importId: string): Promise<IImportedDocument> => {
  const current = await latestImport(projectId)
  if (!mongoose.isValidObjectId(importId) || !current) throw new Mode1Error("IMPORT_NOT_FOUND", "Không tìm thấy lần import")
  if (String(current._id) !== importId) {
    const exists = await ImportedDocument.exists({ _id: importId, projectId })
    if (!exists) throw new Mode1Error("IMPORT_NOT_FOUND", "Không tìm thấy lần import")
    throw new Mode1Error("IMPORT_INVALID_STATE", "Lần import này đã bị thay bằng file upload sau", {
      status: current.status,
      to: current.status,
      allowed: []
    })
  }
  return current
}

export const assertImportStatus = (doc: IImportedDocument, allowed: readonly ImportStatus[], to: ImportStatus): void => {
  if (doc.status === "awaiting_latest_confirm" && !allowed.includes("awaiting_latest_confirm")) {
    throw new Mode1Error("IMPORT_NEEDS_LATEST_CONFIRM", "Cần xác nhận đây là bản mới nhất của tài liệu trước", { import_id: String(doc._id) })
  }
  if (!allowed.includes(doc.status)) {
    throw new Mode1Error("IMPORT_INVALID_STATE", `Không thực hiện được khi lần nhập tài liệu đang ở bước "${IMPORT_STATUS_LABELS[doc.status] ?? doc.status}"`, { status: doc.status, to, allowed })
  }
}

// ─── 1.1–1.3 upload + preflight ──────────────────────────────────

export const uploadImport = async (projectId: string, userId: string, file: UploadedFile): Promise<IImportedDocument> => {
  const current = await latestImport(projectId)
  if (current && hasBaseline(current.status)) {
    throw new Mode1Error("IMPORT_INVALID_STATE", "Dự án đã có bản gốc — hãy tải bản mới bằng chức năng tải lại để xem khác biệt", {
      status: current.status,
      to: "uploaded",
      allowed: []
    })
  }

  const result = await preflightDocx(file.buffer)
  if (result.stamp && result.stamp.project_id !== projectId) {
    throw new Mode1Error("IMPORT_STAMP_FOREIGN_PROJECT", "File này được xuất từ một project FlintFlow khác", { stamp: result.stamp })
  }
  const base = {
    projectId,
    sha256: createHash("sha256").update(file.buffer).digest("hex"),
    original_name: file.originalname,
    size: file.size,
    stamp: result.stamp,
    created_by: userId
  }

  if (result.status === "rejected") {
    const rejected = await ImportedDocument.create({ ...base, file_ref: null, preflight: { status: "rejected", issues: result.issues }, status: "uploaded" })
    await transitionImport(rejected, "preflight_rejected")
    throw new Mode1Error("IMPORT_FILE_REJECTED", "File chưa nhập được, xem danh sách lỗi", { import_id: String(rejected._id), issues: result.issues })
  }

  const fileRef = await docFileStore().save(file.buffer, { projectId, kind: "upload", name: file.originalname })
  const doc = await ImportedDocument.create({ ...base, file_ref: fileRef, preflight: { status: "accepted", issues: [] }, status: "uploaded" })
  if (result.stamp) {
    // Stamp đúng project (file từng xuất từ chính project này, chưa có baseline) ⇒ coi như đã xác nhận
    doc.confirmed_latest_at = new Date()
    await transitionImport(doc, "parsing")
    await runParse(doc)
  } else {
    await transitionImport(doc, "awaiting_latest_confirm")
  }
  return doc
}

export const confirmLatest = async (projectId: string, importId: string): Promise<IImportedDocument> => {
  const doc = await requireImport(projectId, importId)
  assertImportStatus(doc, ["awaiting_latest_confirm"], "parsing")
  doc.confirmed_latest_at = new Date()
  await transitionImport(doc, "parsing")
  await runParse(doc)
  return doc
}

// ─── 1.5–1.6 parse + profile ─────────────────────────────────────

export const loadImportFile = async (doc: IImportedDocument): Promise<Buffer> => {
  if (!doc.file_ref) throw new Mode1Error("IMPORT_INVALID_STATE", "Lần import không có file", { status: doc.status, to: doc.status, allowed: [] })
  return docFileStore().load(doc.file_ref)
}

const toBlockDoc = (projectId: mongoose.Types.ObjectId, b: ParsedBlock, sectionId: string | null) => ({
  projectId,
  doc_version: IMPORTED_DOC_VERSION,
  block_id: b.block_id,
  kind: b.kind,
  level: b.level,
  heading_path: b.heading_path,
  anchor: { bookmark: b.bookmark, para_id: b.para_id, xml_path: b.xml_path, ordinal: b.ordinal },
  text: b.text,
  text_hash: b.text_hash,
  section_id: sectionId,
  mentions: b.mentions,
  editable: b.editable,
  locked_by_cr: null,
  image_ref: b.image_ref ?? null
})

/** Dọn dữ liệu của lần import trước (chưa có baseline nên chỉ có version `0.0`). */
const clearPreviousImportData = async (projectId: mongoose.Types.ObjectId): Promise<void> => {
  await Promise.all([
    DocBlock.deleteMany({ projectId, doc_version: IMPORTED_DOC_VERSION }),
    TemplateProfile.deleteMany({ projectId }),
    ExtractionDraft.deleteMany({ projectId })
  ])
}

export const runParse = async (doc: IImportedDocument): Promise<void> => {
  const { blocks } = await parseDocument(await loadImportFile(doc))
  const profile = matchProfile(blocks)
  const sections = assignBlockSections(blocks, profile.heading_map)
  await clearPreviousImportData(doc.projectId)
  await DocBlock.insertMany(blocks.map((b) => toBlockDoc(doc.projectId, b, sections.get(b.block_id) ?? null)))
  await TemplateProfile.create({ projectId: doc.projectId, source: "imported", doc_version: IMPORTED_DOC_VERSION, ...profile })
  await transitionImport(doc, needsMappingReview(profile) ? "mapping_review" : "extracting")
}

// ─── 1.7 xác nhận mapping ────────────────────────────────────────

/** Ghi lại `section_id` của block sau khi mapping heading đổi. */
export const recomputeBlockSections = async (projectId: mongoose.Types.ObjectId, profile: ITemplateProfile): Promise<void> => {
  const blocks = await DocBlock.find({ projectId, doc_version: profile.doc_version }).sort({ "anchor.ordinal": 1 }).select("block_id kind level section_id").lean()
  const sections = assignBlockSections(
    blocks.map((b) => ({ block_id: b.block_id, kind: b.kind, level: b.level ?? null, text: "" })),
    profile.heading_map
  )
  const ops = blocks
    .filter((b) => (sections.get(b.block_id) ?? null) !== (b.section_id ?? null))
    .map((b) => ({ updateOne: { filter: { _id: b._id }, update: { $set: { section_id: sections.get(b.block_id) ?? null } } } }))
  if (ops.length) await DocBlock.bulkWrite(ops)
}

export const patchMapping = async (projectId: string, body: MappingPatchRequest): Promise<IImportedDocument> => {
  const doc = await requireImport(projectId, body.import_id)
  assertImportStatus(doc, ["mapping_review"], "extracting")
  const profile = await TemplateProfile.findOne({ projectId })
  if (!profile) throw new Mode1Error("IMPORT_INVALID_STATE", "Chưa đọc xong bố cục tài liệu", { status: doc.status, to: "extracting", allowed: [] })

  for (const h of body.headings) {
    const entry = profile.heading_map.find((e) => e.block_id === h.block_id)
    if (!entry) throw new Mode1Error("IMPORT_INVALID_STATE", "Tiêu đề được chọn không có trong tài liệu", { status: doc.status, to: "extracting", allowed: [] })
    if (!isKnownSectionId(h.section_id)) {
      throw new Mode1Error("IMPORT_INVALID_STATE", "Mục được chọn không có trong mẫu FPT", { status: doc.status, to: "extracting", allowed: [] })
    }
    entry.section_id = h.section_id
    entry.confirmed = true
  }
  for (const t of body.tables) {
    const entry = profile.table_map.find((e) => e.block_id === t.block_id && e.column_index === t.column_index)
    if (!entry) throw new Mode1Error("IMPORT_INVALID_STATE", `Không tìm thấy cột thứ ${t.column_index + 1} của bảng đã chọn`, { status: doc.status, to: "extracting", allowed: [] })
    entry.field_path = t.field_path
    entry.confirmed = true
  }
  if (body.confirm_all) {
    for (const e of [...profile.heading_map, ...profile.table_map]) e.confirmed = true
  }
  profile.required_sections = missingRequiredSections(profile.heading_map)
  profile.markModified("heading_map")
  profile.markModified("table_map")
  await profile.save()
  await recomputeBlockSections(doc.projectId, profile)
  if (!needsMappingReview(profile)) await transitionImport(doc, "extracting")
  return doc
}

// ─── UC-19 xem trạng thái ────────────────────────────────────────

export const extractionSummary = async (importId: mongoose.Types.ObjectId | string): Promise<GetImportResponse["extraction"]> => {
  const drafts = await ExtractionDraft.find({ import_id: importId }).lean()
  const review_fields: ReviewField[] = []
  const sections = drafts.map((d) => {
    const needing = d.fields.filter((f) => !f.confirmed && needsConfirm(f))
    for (const f of needing) {
      review_fields.push({
        section_id: d.section_id,
        path: f.path,
        value: f.value,
        confidence: f.confidence,
        source_block_ids: f.source_block_ids,
        origin: f.origin,
        confirmed: f.confirmed,
        ...(f.edited_value !== undefined ? { edited_value: f.edited_value } : {})
      })
    }
    return { section_id: d.section_id, status: d.status, fields_total: d.fields.length, fields_needing_review: needing.length, error: d.error ?? null }
  })
  return { sections, review_fields }
}

export const getImportView = async (projectId: string): Promise<GetImportResponse> => {
  const doc = await latestImport(projectId)
  if (!doc) return { import: null, profile: null, extraction: { sections: [], review_fields: [] }, blocks_count: 0 }
  const [profile, extraction, blocksCount] = await Promise.all([
    TemplateProfile.findOne({ projectId }),
    extractionSummary(doc._id as mongoose.Types.ObjectId),
    DocBlock.countDocuments({ projectId, doc_version: IMPORTED_DOC_VERSION })
  ])
  return { import: toImportDto(doc), profile: profile ? toProfileDto(profile) : null, extraction, blocks_count: blocksCount }
}
