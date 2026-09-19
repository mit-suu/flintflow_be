/**
 * Finalize import (nút 1.10) rồi check (1.11–1.12). FLF-171, plan §6 2C.
 *   1. Field đã xác nhận (hoặc độ tin ≥ 0.7) ⇒ thực thể ⇒ op; áp trong **một** transaction `by: "import"`.
 *   2. Đổi section tạm `feature:@B…`/`function:@B…` sang id thật ở template profile + block; ghi `FieldAnchor`;
 *      quét lại mention theo tên (actor, entity, feature, screen).
 *   3. Mode 1 v2 (FLF-183): layout + mục riêng (`custom_sections`) theo file upload, kế hoạch step theo template (D6),
 *      seed `steps[]` + `progress` ⇒ workspace như mode 2 chạy tiếp từ step còn thiếu. Một txn thứ hai `by: import`.
 *   4. Bản lưu `0.0` = file gốc + bookmark neo + stamp ⇒ GridFS; `DocVersion 0.0`; baseline `type: imported`.
 *   5. `checking` ⇒ AI semantic + code rule ⇒ `gap_review` (AI lỗi/hết credit ⇒ paused, resume chạy tiếp).
 * Không dùng `signOff` (mode 2): baseline v0 không bị cờ đỏ chặn — cờ đi vào gap report (P0 báo cáo §3 dòng 6).
 */

import { ApiError } from "../../shared/utils/api-error.js"
import { writeStamp } from "../docx-ooxml/index.js"
import { docFileStore } from "../doc-version/doc-file.store.js"
import { DocVersion } from "../doc-version/doc-version.model.js"
import { IMPORTED_DOC_VERSION } from "../doc-version/versioning.js"
import { snapshotBaseline } from "../pipeline/s9/baseline.service.js"
import { applyTransaction } from "../spine/op-engine.js"
import * as spineRepository from "../spine/spine.repository.js"
import type { Baseline as BaselineEntry } from "../spine/spine.types.js"
import { countOpenFlags, runImportCheck, stripRecord } from "./check.service.js"
import { DocBlock } from "./doc-block.model.js"
import { collectEntities, realSectionId, resolveProvisional } from "./extracted-entities.js"
import { ExtractionDraft } from "./extraction-draft.model.js"
import { FieldAnchor } from "./field-anchor.model.js"
import { FIELD_CONFIDENCE_THRESHOLD } from "./import.constants.js"
import type { FinalizeRequest } from "./import.dto.js"
import { assertImportStatus, loadImportFile, requireImport, transitionImport } from "./import.service.js"
import type { IImportedDocument } from "./imported-document.model.js"
import { scanMentions, type NamedEntity } from "./mentions.js"
import { Mode1Error } from "./mode1.errors.js"
import { parseDocument } from "./parse.service.js"
import { buildImportOps } from "./spine-builder.js"
import { buildLayout, buildStepPlan, customSectionOps, sectionsWithContent, seedStepOps, type LayoutBlock } from "./step-plan.js"
import { TemplateProfile } from "./template-profile.model.js"

export interface FinalizeResult {
  doc: IImportedDocument
  baseline: BaselineEntry
  spine_version: number
  flags: { red: number; yellow: number }
}

const loadSpine = async (projectId: string) => {
  const record = await spineRepository.get(projectId)
  if (!record) throw new ApiError(404, "Không tìm thấy Spine của dự án", spineRepository.SPINE_NOT_FOUND)
  return record
}

export const finalizeImport = async (projectId: string, userId: string, body: FinalizeRequest): Promise<FinalizeResult> => {
  const doc = await requireImport(projectId, body.import_id)
  assertImportStatus(doc, ["baselining"], "checking")
  const before = await loadSpine(projectId)
  if (before.spine_version !== body.base_version) {
    throw new ApiError(409, "Tài liệu vừa được thay đổi ở phiên khác. Vui lòng tải lại rồi thử lại.", spineRepository.SPINE_VERSION_CONFLICT)
  }
  const profile = await TemplateProfile.findOne({ projectId })
  if (!profile) throw new Mode1Error("IMPORT_INVALID_STATE", "Chưa có template profile", { status: doc.status, to: "checking", allowed: [] })
  const provisional = resolveProvisional(profile.heading_map)

  // 1. Thực thể ⇒ op
  const drafts = await ExtractionDraft.find({ import_id: doc._id }).lean()
  const accepted = drafts.flatMap((d) =>
    d.fields.filter((f) => f.confirmed || f.confidence >= FIELD_CONFIDENCE_THRESHOLD).map((f) => ({ ...f, section_id: realSectionId(d.section_id, provisional) }))
  )
  const entities = [...collectEntities(accepted).values()]
  const ops = buildImportOps(stripRecord(before), entities.map((e) => ({ entity: e.entity, id: e.id, value: e.value })))

  // 2. Bản lưu 0.0 (ghi file trước; lô Spine hỏng thì xoá file, không để mồ côi)
  const parsed = await parseDocument(await loadImportFile(doc))
  await writeStamp(parsed.pkg, { project_id: projectId, version: IMPORTED_DOC_VERSION, source: "import" })
  const fileRef = await docFileStore().save(await parsed.pkg.toBuffer(), { projectId, kind: "version", name: IMPORTED_DOC_VERSION })

  let spineVersion = before.spine_version
  let seqRange: { first: number | null; last: number | null } = { first: null, last: null }
  try {
    if (ops.length) {
      const applied = await applyTransaction(projectId, { base_version: before.spine_version, ops, by: "import", reason: `Import SRS ${doc.original_name}`, step_id: null })
      spineVersion = applied.spine_version
      const seqs = applied.changes.map((c) => c.seq)
      if (seqs.length) seqRange = { first: Math.min(...seqs), last: Math.max(...seqs) }
    }
  } catch (err) {
    await docFileStore().remove(fileRef)
    throw err
  }

  // 3. Liên kết Spine ↔ block, section thật cho feature/function, mention theo tên
  const anchors = entities
    .filter((e) => e.entity !== "project" && e.id)
    .map((e) => ({ entity_path: `${e.entity}[id=${e.id}]`, block_ids: [...e.source_block_ids] }))
  if (anchors.length) {
    await FieldAnchor.bulkWrite(
      anchors.map((a) => ({
        updateOne: { filter: { projectId: doc.projectId, entity_path: a.entity_path }, update: { $set: { block_ids: a.block_ids } }, upsert: true }
      }))
    )
  }
  for (const h of profile.heading_map) h.section_id = realSectionId(h.section_id, provisional)
  profile.markModified("heading_map")
  await profile.save()

  const spineNow = await loadSpine(projectId)
  const names: NamedEntity[] = [
    ...spineNow.actors.map((a) => ({ entity: "actor" as const, id: a.id, name: a.name })),
    ...spineNow.entities.map((e) => ({ entity: "entity" as const, id: e.id, name: e.name })),
    ...spineNow.features.map((f) => ({ entity: "feature" as const, id: f.id, name: f.name })),
    ...spineNow.screens.map((s) => ({ entity: "screen" as const, id: s.id, name: s.name }))
  ]
  const blocks = await DocBlock.find({ projectId, doc_version: IMPORTED_DOC_VERSION }).select("block_id text section_id").lean()
  const updates = blocks.map((b) => ({
    updateOne: {
      filter: { _id: b._id },
      update: { $set: { section_id: b.section_id ? realSectionId(b.section_id, provisional) : null, mentions: scanMentions(b.text, names) } }
    }
  }))
  if (updates.length) await DocBlock.bulkWrite(updates)

  // 3b. Layout + mục riêng + kế hoạch step theo template người dùng (mode 1 v2, D2/D6)
  const ordered = await DocBlock.find({ projectId, doc_version: IMPORTED_DOC_VERSION }).sort({ "anchor.ordinal": 1 }).lean()
  const layoutBlocks: LayoutBlock[] = ordered.map((b) => ({
    block_id: b.block_id,
    kind: b.kind,
    level: b.level ?? null,
    text: b.text,
    section_id: b.section_id ?? null,
    // DocBlock không lưu ô bảng — dựng lại từ text `ô | ô` theo dòng
    rows: b.kind === "table" ? b.text.split("\n").map((line) => line.split(" | ")) : null
  }))
  const { layout, customSections } = buildLayout(layoutBlocks, new Map(profile.heading_map.map((h) => [h.block_id, h.section_id])))
  const plan = buildStepPlan(layout, sectionsWithContent(layoutBlocks))
  const seeded = await loadSpine(projectId)
  const planOps = [
    ...customSectionOps(customSections),
    ...seedStepOps(stripRecord(seeded), plan, { firstSeq: seqRange.first, lastSeq: seqRange.last, at: new Date().toISOString() })
  ]
  await applyTransaction(projectId, { base_version: seeded.spine_version, ops: planOps, by: "import", reason: "Import: kế hoạch step theo template", step_id: null })
  profile.layout = layout
  profile.step_plan = plan
  await profile.save()

  // 4. Baseline imported + DocVersion 0.0 — chụp Spine sau lô kế hoạch step
  const planned = await loadSpine(projectId)
  const { baseline, spine_version } = await snapshotBaseline(projectId, stripRecord(planned), {
    base_version: planned.spine_version,
    version: IMPORTED_DOC_VERSION,
    type: "imported",
    doc_version: IMPORTED_DOC_VERSION,
    by: "import",
    step_id: null
  })
  spineVersion = spine_version
  await DocVersion.create({
    projectId,
    version: IMPORTED_DOC_VERSION,
    kind: "imported",
    file_ref: fileRef,
    based_on: null,
    cr_ids: [],
    baseline_ref: baseline.id,
    created_by: userId
  })

  await transitionImport(doc, "checking")
  await runImportCheck(doc, userId)
  const after = await loadSpine(projectId)
  return { doc, baseline, spine_version: after.spine_version ?? spineVersion, flags: countOpenFlags(after.flags) }
}

/** UC-61/UC-75 cho bước check: chạy lại phần còn thiếu của 1.11–1.12. */
export const resumeCheck = async (doc: IImportedDocument, userId: string): Promise<void> => {
  await runImportCheck(doc, userId)
}

