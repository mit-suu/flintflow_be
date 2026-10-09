/**
 * Finalize import (nút 1.10) rồi check (1.11–1.12). FLF-171, plan §6 2C.
 *   1. Field đã xác nhận (hoặc độ tin ≥ 0.7) ⇒ thực thể ⇒ op; áp trong **một** transaction `by: "import"`.
 *   2. Đổi section tạm `feature:@B…`/`function:@B…` sang id thật ở template profile + block; ghi `FieldAnchor`;
 *      quét lại mention theo tên (actor, entity, feature, screen).
 *   3. Mode 1 v2 (FLF-183): layout + mục riêng (`custom_sections`) theo file upload, kế hoạch step theo template (D6),
 *      seed `steps[]` + `progress` ⇒ workspace như mode 2 chạy tiếp từ step còn thiếu. Một txn thứ hai `by: import`.
 *   4. Mode 1 v2 (FLF-184): vẽ diagram từ Spine (PlantUML có mặt), baseline `type: imported`; `DocVersion 0.0` = bản
 *      **render** từ Spine theo layout file upload + stamp, file gốc (bookmark neo + stamp) giữ ở `original_ref`.
 *      §4.13: loại sơ đồ người dùng đã có hình (ảnh I-4 đọc được) thì bản render giữ ảnh gốc, PlantUML loại đó không in.
 *   5. `checking` ⇒ AI semantic + code rule ⇒ `gap_review` (AI lỗi/hết credit ⇒ paused, resume chạy tiếp); ghép sẵn
 *      bản làm việc (`POST /assemble`) để workspace mở được ngay.
 * Không dùng `signOff` (mode 2): baseline v0 không bị cờ đỏ chặn — cờ đi vào gap report (P0 báo cáo §3 dòng 6).
 * HTTP chạy hàm này nền qua `finalize-jobs.ts`; lần chạy dở ở `baselining` được hoàn về mốc (`rollbackPartialFinalize`).
 */

import { ApiError } from "../../shared/utils/api-error.js"
import { writeStamp } from "../docx-ooxml/index.js"
import { docFileStore } from "../doc-version/doc-file.store.js"
import { DocVersion } from "../doc-version/doc-version.model.js"
import { IMPORTED_DOC_VERSION } from "../doc-version/versioning.js"
import { renderVersionFile } from "../doc-version/render-version.js"
import { renderAllIfAvailable } from "../diagram/diagram.service.js"
import { Project } from "../project/project.model.js"
import { assemble } from "../render/assemble.service.js"
import { snapshotBaseline } from "../pipeline/s9/baseline.service.js"
import { Baseline } from "../spine/baseline.model.js"
import { applyTransaction } from "../spine/op-engine.js"
import { isOriginalDiagramKind, originalDiagramHash } from "../spine/original-diagram.js"
import * as spineRepository from "../spine/spine.repository.js"
import type { Op } from "../spine/op.types.js"
import type { Baseline as BaselineEntry, OriginalDiagramKind, Spine } from "../spine/spine.types.js"
import { countOpenFlags, findingOpsInOrder, runImportCheck, stripRecord } from "./check.service.js"
import { legacyRecordRows } from "./legacy-record.js"
import { DocBlock } from "./doc-block.model.js"
import { collectEntities, parseFieldPath, realSectionId, resolveProvisional } from "./extracted-entities.js"
import { ExtractionDraft, type IExtractionDraft } from "./extraction-draft.model.js"
import { FieldAnchor } from "./field-anchor.model.js"
import { needsConfirm } from "./import.constants.js"
import type { FinalizeRequest } from "./import.dto.js"
import { assertImportStatus, loadImportFile, recomputeBlockSections, requireImport, transitionImport } from "./import.service.js"
import type { FinalizeCheckpoint, IImportedDocument } from "./imported-document.model.js"
import { scanMentions, type NamedEntity } from "./mentions.js"
import { Mode1Error } from "./mode1.errors.js"
import { IMPORT_IMAGE_RULE, IMPORT_UNRESOLVED_RULE } from "./mode1-rule-profile.js"
import { parseDocument } from "./parse.service.js"
import { buildImportOps, droppedPermissionFindings, type DroppedPermission } from "./spine-builder.js"
import { tableRows } from "./table-rows.js"
import { buildLayout, buildStepPlan, customSectionOps, functionOriginals, sectionsWithContent, seedStepOps, type LayoutBlock } from "./step-plan.js"
import { functionSourceHash } from "../render/layout-sections.js"
import { TemplateProfile, type LayoutEntry } from "./template-profile.model.js"
import { titleOfSection } from "./gap-report.service.js"

export interface FinalizeResult {
  doc: IImportedDocument
  baseline: BaselineEntry
  spine_version: number
  flags: { red: number; yellow: number }
}

const loadSpine = async (projectId: string) => {
  const record = await spineRepository.get(projectId)
  if (!record) throw new ApiError(404, "Không tìm thấy dữ liệu tài liệu của dự án.", spineRepository.SPINE_NOT_FOUND)
  return record
}

/** Điều kiện finalize (trạng thái, `base_version`, profile) — lỗi 4xx trả ngay cho client, trước khi chạy nền. */
export const assertCanFinalize = async (projectId: string, body: Pick<FinalizeRequest, "import_id" | "base_version">) => {
  const doc = await requireImport(projectId, body.import_id)
  assertImportStatus(doc, ["baselining"], "checking")
  const before = await loadSpine(projectId)
  if (before.spine_version !== body.base_version) {
    throw new ApiError(409, "Tài liệu vừa được thay đổi ở phiên khác. Vui lòng tải lại rồi thử lại.", spineRepository.SPINE_VERSION_CONFLICT)
  }
  const profile = await TemplateProfile.findOne({ projectId })
  if (!profile) throw new Mode1Error("IMPORT_INVALID_STATE", "Chưa đọc xong bố cục tài liệu", { status: doc.status, to: "checking", allowed: [] })
  return { doc, before, profile }
}

export const finalizeImport = async (projectId: string, userId: string, body: FinalizeRequest): Promise<FinalizeResult> => {
  const { doc, before, profile } = await assertCanFinalize(projectId, body)
  const provisional = resolveProvisional(profile.heading_map)

  // 1. Thực thể ⇒ op
  const drafts = await ExtractionDraft.find({ import_id: doc._id }).lean()
  const accepted = drafts.flatMap((d) =>
    d.fields.filter((f) => f.confirmed || !needsConfirm(f)).map((f) => ({ ...f, section_id: realSectionId(d.section_id, provisional) }))
  )
  const entities = [...collectEntities(accepted).values()]
  const droppedPermissions: DroppedPermission[] = []
  const ops = buildImportOps(stripRecord(before), entities.map((e) => ({ entity: e.entity, id: e.id, value: e.value })), droppedPermissions)

  // 2. File gốc của bản 0.0 (ghi file trước; lô Spine hỏng thì xoá file, không để mồ côi)
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
    // Ô thật của bảng (FLF-251) — tách `text` theo dòng làm gãy hàng khi ô có xuống dòng (Record of Changes ra 0 dòng)
    rows: b.kind === "table" ? tableRows(b, ordered) : null,
    image_ref: b.image_ref ?? null
  }))
  // Văn xuôi I-4 không trích được ⇒ phần nối của section (FLF-184) — render từ Spine không mất nội dung file gốc
  const unmappedIds = new Set(drafts.flatMap((d) => d.unmapped_block_ids ?? []))
  // Phase 5 (T3): ảnh dưới mục FPT ⇒ giữ nguyên văn (phần nối của mục) để bản render nhúng lại ảnh gốc. Trước đây bản
  // render 0.0 mất 35/39 ảnh (T1). §4.13: sơ đồ I-4 đọc được (use case / ERD / luồng màn / ngữ cảnh) cũng **giữ y hình
  // của người dùng** — dữ liệu đọc được chỉ vào Spine; khối ảnh mang `diagram` (loại + hash dữ liệu lúc import) để bản
  // render ẩn PlantUML cùng loại, và CR chạm dữ liệu đó sau này đề xuất vẽ lại bằng PlantUML.
  const imageRead = new Map(
    drafts.flatMap((d) => (d.diagram_images ?? []).filter((i) => isOriginalDiagramKind(i.kind)).map((i) => [i.block_id, i.kind as OriginalDiagramKind] as const))
  )
  const imported = stripRecord(spineNow)
  for (const b of layoutBlocks) {
    if (b.kind !== "image" || !b.image_ref || !b.section_id) continue
    unmappedIds.add(b.block_id)
    const kind = imageRead.get(b.block_id)
    if (kind) b.diagram = { kind, source_hash: originalDiagramHash(imported, kind) }
  }
  const { layout, customSections } = buildLayout(layoutBlocks, new Map(profile.heading_map.map((h) => [h.block_id, h.section_id])), unmappedIds)
  const seeded = await loadSpine(projectId)
  // Kế hoạch đọc Spine đã nạp dữ liệu: mục trích không ra gì thì vẫn là "thiếu", đừng đánh dấu step đã xong
  const plan = buildStepPlan(layout, sectionsWithContent(layoutBlocks), stripRecord(seeded))
  // FLF-252: quyền của ma trận không khớp màn / vai trò nào ⇒ cờ vàng (trước đây bỏ im lặng), neo vào bảng phân quyền
  const matrixBlocks = [...new Set(entities.filter((e) => e.entity === "permissions").flatMap((e) => [...e.source_block_ids]))].slice(0, 1)
  const planOps = [
    ...customSectionOps(customSections),
    // Hai nhóm cờ trong cùng lô ⇒ id cờ cấp nối tiếp (gọi riêng từng nhóm thì trùng id, cả lô bị từ chối)
    ...findingOpsInOrder(stripRecord(seeded), [
      { findings: unreadImageFindings(stripRecord(seeded), drafts, layout, provisional), rule: IMPORT_IMAGE_RULE },
      { findings: droppedPermissionFindings(droppedPermissions, matrixBlocks), rule: IMPORT_UNRESOLVED_RULE }
    ]),
    ...seedStepOps(stripRecord(seeded), plan, { firstSeq: seqRange.first, lastSeq: seqRange.last, at: new Date().toISOString() })
  ]
  await applyTransaction(projectId, { base_version: seeded.spine_version, ops: planOps, by: "import", reason: "Import: kế hoạch step theo template", step_id: null })
  profile.layout = layout
  profile.step_plan = plan
  // T15: giữ lịch sử sửa đổi của khách (bảng dưới heading Record of Changes) — render in lên đầu bảng §I.
  // FLF-252: dòng người dùng đã xem/sửa ở wizard thắng; không gửi ⇒ đọc lại từ file
  profile.legacy_record_of_changes =
    body.record_of_changes ?? legacyRecordRows(layoutBlocks, new Map(profile.heading_map.map((h) => [h.block_id, h.section_id])))
  // FLF-252: chức năng đọc từ bảng Non-Screen Functions của file — bản in giữ đúng các dòng của bảng này
  profile.non_screen_table = nonScreenTableIds(drafts)
  // FLF-252 — in theo file gốc: nguyên văn từng mục chức năng + dấu nội dung chức năng lúc nhập (chức năng không đổi ở lô
  // kế hoạch step nên dấu tính trên Spine sau lô thực thể)
  const fnById = new Map(seeded.functions.map((f) => [`function:${f.id}`, f]))
  profile.function_originals = [...functionOriginals(layoutBlocks, new Map(profile.heading_map.map((h) => [h.block_id, h.section_id])))].flatMap(
    ([section_id, blocks]) => {
      const fn = fnById.get(section_id)
      return fn && blocks.length ? [{ section_id, source_hash: functionSourceHash(fn), blocks }] : []
    }
  )
  await profile.save()

  // 4. Diagram từ Spine (use case, ERD, luồng màn, ngữ cảnh) ⇒ bản render có hình như mode 2 cho loại người dùng chưa có
  // hình; loại đã có sơ đồ gốc thì hình PlantUML vẫn vẽ sẵn (in ra ngay khi CR bỏ ảnh gốc) nhưng không in (§4.13)
  await renderDiagramsIfAvailable(projectId)

  // Baseline imported + DocVersion 0.0 — chụp Spine sau lô kế hoạch step; file 0.0 = bản render của đúng snapshot đó
  const planned = await loadSpine(projectId)
  const projectName = (await Project.findById(projectId, { name: 1 }).lean())?.name ?? doc.original_name
  const renderedRef = await docFileStore().save(
    await renderVersionFile(projectId, projectName, stripRecord(planned), { version: IMPORTED_DOC_VERSION, stampSource: "import" }),
    { projectId, kind: "version", name: IMPORTED_DOC_VERSION }
  )
  let baseline: BaselineEntry
  try {
    const snap = await snapshotBaseline(projectId, stripRecord(planned), {
      base_version: planned.spine_version,
      version: IMPORTED_DOC_VERSION,
      type: "imported",
      doc_version: IMPORTED_DOC_VERSION,
      by: "import",
      step_id: null
    })
    baseline = snap.baseline
    spineVersion = snap.spine_version
  } catch (err) {
    await docFileStore().remove(renderedRef)
    throw err
  }
  await DocVersion.create({
    projectId,
    version: IMPORTED_DOC_VERSION,
    kind: "imported",
    file_ref: renderedRef,
    original_ref: fileRef,
    based_on: null,
    cr_ids: [],
    baseline_ref: baseline.id,
    created_by: userId
  })

  await transitionImport(doc, "checking")
  await runImportCheck(doc, userId)
  const after = await loadSpine(projectId)
  await assembleWorkingDraft(projectId, projectName, after.spine_version)
  return { doc, baseline, spine_version: after.spine_version ?? spineVersion, flags: countOpenFlags(after.flags) }
}

/** Id chức năng đọc từ bảng Non-Screen Functions (mục 3.1.4) của file, theo thứ tự bảng (FLF-252). */
export const nonScreenTableIds = (drafts: Pick<IExtractionDraft, "section_id" | "fields">[]): string[] => {
  const ids: string[] = []
  for (const d of drafts.filter((x) => x.section_id === "fixed:3.1.4")) {
    for (const f of d.fields) {
      const p = parseFieldPath(f.path)
      if (p?.entity === "functions" && p.id && !ids.includes(p.id)) ids.push(p.id)
    }
  }
  return ids
}

const UNREAD_REASON: Readonly<Record<string, string>> = {
  unsupported: "định dạng ảnh không hỗ trợ",
  unavailable: "AI đọc ảnh đang quá tải, chưa đọc được"
}

/** Ảnh ở mục diagram mà I-4 không đọc được (`other` / EMF / AI lỗi…) ⇒ cờ vàng: ảnh gốc được giữ, dữ liệu trong ảnh chưa vào Spine. */
const unreadImageFindings = (
  spine: Spine,
  drafts: Pick<IExtractionDraft, "section_id" | "diagram_images">[],
  layout: readonly LayoutEntry[],
  provisional: ReturnType<typeof resolveProvisional>
): { rule: string; section_id: string; message: string; block_ids: string[] }[] => {
  // Câu cho người đọc: nêu mục theo tiêu đề trong file, không in tên file ảnh / block id (`[image] media/x.emf`, `B0012`)
  const findings = drafts.flatMap((d) => {
    const section_id = realSectionId(d.section_id, provisional)
    const heading = layout.find((l) => l.section_id === d.section_id && l.heading_text.trim())?.heading_text.trim()
    const title = heading ?? titleOfSection(spine, section_id, layout)
    const unread = (d.diagram_images ?? []).filter((i) => !isOriginalDiagramKind(i.kind))
    return unread.map((i, n) => ({
      rule: "image",
      section_id,
      message: `${unread.length > 1 ? `Ảnh thứ ${n + 1}` : "Ảnh"} trong mục "${title}" không đọc được thành dữ liệu (${UNREAD_REASON[i.kind] ?? "không phải sơ đồ đọc được"}) — đã giữ ảnh gốc; cần thì cập nhật qua change request`,
      block_ids: [i.block_id]
    }))
  })
  return findings
}

/**
 * Vẽ lại mọi diagram từ Spine vừa import. PlantUML không có mặt (dev/test, sự cố) ⇒ bỏ qua thay vì ghi hàng loạt
 * `render_error`: người dùng vẽ lại sau ở workspace. Lỗi vẽ không chặn import.
 */
const renderDiagramsIfAvailable = async (projectId: string): Promise<void> => {
  await renderAllIfAvailable(projectId, { by: "import", step_id: null })
}

/** Ghép sẵn bản làm việc (S-8.2) — lỗi chỉ ghi log: workspace tự `POST /assemble` lại được. */
const assembleWorkingDraft = async (projectId: string, projectName: string, spineVersion: number): Promise<void> => {
  try {
    await assemble(projectId, projectName, spineVersion)
  } catch (err) {
    console.warn(`[finalize] ghép bản làm việc sau import lỗi (project ${projectId}): ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ─── chạy lại sau lần finalize dở ─────────────────────────────────

/** Mốc hiện tại để hoàn về nếu lần finalize sắp chạy bị dở (ghi vào `ImportedDocument.finalize_checkpoint`). */
export const finalizeCheckpoint = async (projectId: string, recordOfChanges: FinalizeRequest["record_of_changes"] | null): Promise<FinalizeCheckpoint> => {
  const [spine, nextSeq, profile] = await Promise.all([loadSpine(projectId), spineRepository.nextSeq(projectId), TemplateProfile.findOne({ projectId }).lean()])
  return {
    spine_version: spine.spine_version,
    spine: stripRecord(spine),
    next_seq: nextSeq,
    headings: (profile?.heading_map ?? []).map((h) => ({ block_id: h.block_id, section_id: h.section_id })),
    record_of_changes: recordOfChanges
  }
}

/**
 * Hoàn lần finalize dở ở `baselining` về `finalize_checkpoint` để chạy lại sạch, như thể lần đó chưa chạy: Spine về đúng
 * nội dung mốc + bỏ change của lần đó (`restoreSnapshot` — revert bằng op không về được Spine rỗng vì bất biến "phần tử
 * cuối"), xoá bản 0.0 + snapshot baseline đã ghi, trả heading về section tạm (block đổi theo). FieldAnchor / mention /
 * layout không cần hoàn: lần chạy lại ghi đè cùng giá trị. Không có mốc ⇒ không làm gì; gọi lại nhiều lần vẫn về đúng mốc.
 */
export const rollbackPartialFinalize = async (doc: IImportedDocument): Promise<void> => {
  const checkpoint = doc.finalize_checkpoint
  if (!checkpoint || doc.status !== "baselining") return
  const projectId = String(doc.projectId)
  const spine = await loadSpine(projectId)
  const touched = spine.spine_version !== checkpoint.spine_version || (await spineRepository.nextSeq(projectId)) !== checkpoint.next_seq
  if (touched) await spineRepository.restoreSnapshot(projectId, checkpoint.spine, { baseVersion: spine.spine_version, fromSeq: checkpoint.next_seq })
  const versions = await DocVersion.find({ projectId, version: IMPORTED_DOC_VERSION }).lean()
  for (const ref of versions.flatMap((v) => [v.file_ref, v.original_ref].filter((r): r is string => !!r))) {
    await docFileStore().remove(ref).catch(() => undefined)
  }
  await DocVersion.deleteMany({ projectId, version: IMPORTED_DOC_VERSION })
  await Baseline.deleteMany({ projectId, version: IMPORTED_DOC_VERSION, type: "imported" })

  const profile = await TemplateProfile.findOne({ projectId })
  if (profile) {
    const original = new Map(checkpoint.headings.map((h) => [h.block_id, h.section_id]))
    for (const h of profile.heading_map) h.section_id = original.get(h.block_id) ?? h.section_id
    profile.markModified("heading_map")
    await profile.save()
    await recomputeBlockSections(doc.projectId, profile)
  }
  // Mốc mới: cùng nội dung + seq, version sau khi khôi phục (lần gọi sau không khôi phục lại)
  doc.finalize_checkpoint = { ...(await finalizeCheckpoint(projectId, checkpoint.record_of_changes)), headings: checkpoint.headings }
  doc.markModified("finalize_checkpoint")
  await doc.save()
}

/** UC-61/UC-75 cho bước check: chạy lại phần còn thiếu của 1.11–1.12. */
export const resumeCheck = async (doc: IImportedDocument, userId: string): Promise<void> => {
  await runImportCheck(doc, userId)
}

