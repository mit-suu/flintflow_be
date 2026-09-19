/**
 * C-7 ghi thay đổi đã duyệt (nút 3.14). FLF-171, plan §6 2E.
 * Trên bản sao file của version mới nhất: `edit` ⇒ Track Changes theo từ, `comment` ⇒ comment Word, author = mã CR.
 * Lưu file (GridFS) **trước**, rồi: op Spine (`by = cr_id`, reason = mã CR + tiêu đề) → recompute cờ (hồ sơ mode 1)
 * → `DocVersion` minor mới + block của version mới (giữ `block_id` theo bookmark, giữ khoá của CR khác) → mở khoá.
 * Lỗi giữa chừng ⇒ xoá file mồ côi, CR giữ nguyên trạng thái (chạy lại an toàn).
 */

import { ApiError } from "../../shared/utils/api-error.js"
import {
  DocxPackage,
  OoxmlError,
  RevisionIds,
  addComment,
  applyEdit,
  bookmarkName,
  findBlock,
  readBlocks,
  textHash,
  writeStamp
} from "../docx-ooxml/index.js"
import { docFileStore } from "../doc-version/doc-file.store.js"
import { DocVersion } from "../doc-version/doc-version.model.js"
import { blocksOfVersion, latestDocVersion } from "../doc-version/doc-version.service.js"
import { nextMinor } from "../doc-version/versioning.js"
import { stripRecord } from "../import/check.service.js"
import { DocBlock } from "../import/doc-block.model.js"
import { scanMentions } from "../import/mentions.js"
import { Mode1Error } from "../import/mode1.errors.js"
import { MODE1_RULE_PROFILE } from "../import/mode1-rule-profile.js"
import { assignBlockIds } from "../import/parse.service.js"
import * as flagsService from "../spine/flags.service.js"
import { applyTransaction } from "../spine/op-engine.js"
import { userOpSchema, type Op } from "../spine/op.types.js"
import * as spineRepository from "../spine/spine.repository.js"
import type { IChangeRequest } from "./change-request.model.js"
import type { IChangeLocation } from "./change-location.model.js"
import { namedEntities } from "./cr-context.js"
import { unlockBlocks } from "./lock.service.js"

const mismatch = (loc: IChangeLocation): Mode1Error =>
  new Mode1Error("CR_OLD_TEXT_MISMATCH", `Text block ${loc.block_id} đã đổi so với đề xuất`, { location_id: loc.location_id, block_id: loc.block_id })

/** Ghi các vị trí đã duyệt thành version minor mới. Trả version mới. */
export const writeApproved = async (cr: IChangeRequest, userId: string, approved: IChangeLocation[], baseVersion: number): Promise<string> => {
  const projectId = String(cr.projectId)
  const record = await spineRepository.get(projectId)
  if (!record) throw new ApiError(404, "Không tìm thấy Spine của dự án", spineRepository.SPINE_NOT_FOUND)
  if (record.spine_version !== baseVersion) {
    throw new ApiError(409, "Tài liệu vừa được thay đổi ở phiên khác. Vui lòng tải lại rồi thử lại.", spineRepository.SPINE_VERSION_CONFLICT)
  }
  const version = (await latestDocVersion(projectId))!
  const oldBlocks = await blocksOfVersion(projectId, version.version)
  const oldOf = new Map(oldBlocks.map((b) => [b.block_id, b]))
  const changes = approved.filter((l) => (l.conclusion === "edit" || l.conclusion === "comment") && l.proposal)
  for (const loc of changes) {
    const b = oldOf.get(loc.block_id)
    if (!b || b.text_hash !== textHash(loc.proposal!.old_text)) throw mismatch(loc)
  }

  // 1. File: Track Changes + comment trên bản sao (sau release: bản sạch — CR đã release không hiện lại)
  const pkg = await DocxPackage.load(await docFileStore().load(version.clean_file_ref ?? version.file_ref))
  const ooxml = await readBlocks(pkg)
  const who = { author: cr.cr_id, date: new Date(), ids: new RevisionIds(await pkg.requireXml("word/document.xml")) }
  for (const loc of changes) {
    const b = oldOf.get(loc.block_id)!
    const target = findBlock(ooxml, { bookmark: b.anchor.bookmark ?? bookmarkName(b.block_id), para_id: b.anchor.para_id, text_hash: b.text_hash })
    if (!target) throw mismatch(loc)
    if (loc.conclusion === "edit") {
      try {
        applyEdit(target.element, loc.proposal!.old_text, loc.proposal!.new_text ?? "", who)
      } catch (err) {
        if (err instanceof OoxmlError && err.code === "OLD_TEXT_MISMATCH") throw mismatch(loc)
        throw err
      }
    } else {
      await addComment(pkg, target.element, loc.proposal!.comment_text ?? "", { author: cr.cr_id, date: who.date })
    }
  }
  const next = nextMinor(version.version)
  await writeStamp(pkg, { project_id: projectId, version: next, source: "cr_revision" })
  const buffer = await pkg.toBuffer()
  const fileRef = await docFileStore().save(buffer, { projectId, kind: "version", name: next })

  try {
    // 2. Spine
    const ops: Op[] = changes.flatMap((l) => (l.proposal!.spine_ops ?? []).map((raw) => userOpSchema.parse(raw)))
    if (ops.length) {
      await applyTransaction(projectId, { base_version: baseVersion, ops, by: cr.cr_id, reason: `${cr.cr_id}: ${cr.title}`, step_id: null })
    }
    await flagsService.recompute(projectId, { by: cr.cr_id, ruleProfile: MODE1_RULE_PROFILE })

    // 3. Version + block của version mới
    const spine = stripRecord((await spineRepository.get(projectId))!)
    const names = namedEntities(spine)
    const fresh = assignBlockIds(await readBlocks(await DocxPackage.load(buffer)))
    await DocBlock.insertMany(
      fresh.map((b) => {
        const prev = oldOf.get(b.block_id)
        return {
          projectId,
          doc_version: next,
          block_id: b.block_id,
          kind: b.kind,
          level: b.level,
          heading_path: b.heading_path,
          anchor: { bookmark: b.bookmark, para_id: b.para_id, xml_path: b.xml_path, ordinal: b.ordinal },
          text: b.text,
          text_hash: b.text_hash,
          section_id: prev?.section_id ?? null,
          mentions: scanMentions(b.text, names),
          editable: b.editable,
          locked_by_cr: prev?.locked_by_cr && prev.locked_by_cr !== cr.cr_id ? prev.locked_by_cr : null
        }
      })
    )
    await DocVersion.create({ projectId, version: next, kind: "cr_revision", file_ref: fileRef, based_on: version.version, cr_ids: [cr.cr_id], baseline_ref: null, created_by: userId })
  } catch (err) {
    await DocBlock.deleteMany({ projectId, doc_version: next })
    await docFileStore().remove(fileRef)
    throw err
  }
  await unlockBlocks(projectId, cr.cr_id)
  return next
}
