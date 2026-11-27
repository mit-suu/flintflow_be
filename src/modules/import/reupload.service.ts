/**
 * Upload lại SRS (I-1 → bước 1.3a, UC-24): so file mới với bản đang có theo block, **không** tạo version. FLF-171, plan §6 2D.
 * - Sau baseline: so với file version tài liệu mới nhất; người dùng xem khác biệt rồi (tuỳ) tạo CR nguồn `reupload`.
 * - FLF-457, trước baseline (dự án đang soạn, chưa có version): so với nội dung đang soạn, đúng file tải về bản DRAFT;
 *   chỗ nào nhận thì thành bản sửa qua chat (nguyên tắc 6), không tạo CR.
 * - Stamp của project khác ⇒ `IMPORT_STAMP_FOREIGN_PROJECT`.
 * - FLF-457: file **không dấu version** (người dùng chọn Cập nhật phiên bản mới) không bị coi là file mới: so theo nội dung
 *   với bản nháp hiện tại, báo `no_stamp`; heading khớp dưới ngưỡng ⇒ `suggest_reference` (gợi ý Dùng làm tham khảo).
 * - FLF-457: Track Changes / comment của người ngoài được nhận (lần import đầu vẫn từ chối), mỗi chỗ một dòng `markup`.
 * - FLF-457: dấu version cũ hơn bản hiện tại ⇒ `stale` (vẫn so, cảnh báo dễ đưa ngược thay đổi đã ghi).
 * Mode 1 v2 (FLF-186): so với **file render** (người ngoài sửa trên bản tải về), khớp theo text.
 */

import { createHash } from "node:crypto"
import type { OoxmlBlock } from "../docx-ooxml/index.js"
import { diffBlockLists, toDiffBlocks } from "../doc-version/block-diff.js"
import { docFileStore } from "../doc-version/doc-file.store.js"
import { fileBlocks, fileBlocksOfVersion, latestDocVersion } from "../doc-version/doc-version.service.js"
import { compareDocVersions, isDocVersion } from "../doc-version/versioning.js"
import { Project, type IProject } from "../project/project.model.js"
import { NoWorkingDraftError } from "../render/assemble.service.js"
import { renderExportDocx } from "../render/export.controller.js"
import { contextOf } from "../render/render.controller.js"
import type { ReuploadDiffDto } from "./import.dto.js"
import { hasBaseline } from "./import.state.js"
import { latestImport, type UploadedFile } from "./import.service.js"
import { Mode1Error } from "./mode1.errors.js"
import { toIso } from "./mode1.http.js"
import { preflightDocx } from "./preflight.service.js"
import { ReuploadDiff, type IReuploadDiff } from "./reupload-diff.model.js"
import { splitHeadingNumber, titleSimilarity } from "./text-similarity.js"

/** `against_version` khi chưa có baseline: so với nội dung đang soạn (bản DRAFT). */
export const BEFORE_BASELINE_VERSION = "DRAFT"

/**
 * FLF-457: tỉ lệ heading của bản đang so tìm thấy trong file dưới mức này ⇒ file không dấu version nhiều khả năng là tài liệu
 * khác ⇒ gợi ý Dùng làm tham khảo.
 */
export const REUPLOAD_HEADING_MATCH_MIN = 0.5
/** Hai heading coi là một khi chữ (bỏ số mục) giống nhau tới mức này. */
const HEADING_SIMILARITY = 0.8

const headingTitles = (blocks: readonly OoxmlBlock[]): string[] =>
  blocks.filter((b) => b.kind === "heading" && b.text.trim()).map((b) => splitHeadingNumber(b.text).title)

/** Phần heading của bản đang so (`current`) có heading tương ứng trong file (`file`); bản đang so không heading ⇒ 1. */
export const headingMatchRatio = (current: readonly OoxmlBlock[], file: readonly OoxmlBlock[]): number => {
  const ours = headingTitles(current)
  if (!ours.length) return 1
  const theirs = headingTitles(file)
  const hit = ours.filter((h) => theirs.some((t) => titleSimilarity(h, t) >= HEADING_SIMILARITY)).length
  return Math.round((hit / ours.length) * 100) / 100
}

export const toReuploadDto = (d: IReuploadDiff): ReuploadDiffDto => {
  const count = (c: string): number => d.blocks.filter((b) => b.change === c).length
  return {
    id: String(d._id),
    original_name: d.original_name,
    against_version: d.against_version,
    created_at: toIso(d.createdAt)!,
    summary: { added: count("added"), removed: count("removed"), modified: count("modified"), moved: count("moved") },
    blocks: d.blocks.map((b) => ({
      block_id: b.block_id ?? null,
      change: b.change,
      ...(b.before !== undefined ? { before: b.before } : {}),
      ...(b.after !== undefined ? { after: b.after } : {}),
      ...(b.section !== undefined && b.section !== null ? { section: b.section } : {}),
      ...(b.section_key !== undefined && b.section_key !== null ? { section_key: b.section_key } : {}),
      ...(b.kind ? { kind: b.kind } : {}),
      ...(b.table ? { table: b.table } : {})
    })),
    sections: (d.sections ?? []).map((s) => ({ title: s.title, ...(s.key ? { key: s.key } : {}), unchanged: s.unchanged })),
    before_baseline: d.before_baseline ?? false,
    no_stamp: d.no_stamp ?? false,
    heading_match: d.heading_match ?? 1,
    suggest_reference: d.suggest_reference ?? false,
    stale: d.stale?.file_version ? { file_version: d.stale.file_version, current_version: d.stale.current_version } : null,
    markup: (d.markup ?? []).map((m) => ({
      kind: m.kind,
      author: m.author ?? "",
      ...(m.change ? { change: m.change } : {}),
      text: m.text ?? "",
      section: m.section ?? "",
      location: m.location ? { block_ord: m.location.block_ord, text: m.location.text } : null
    }))
  }
}

const noBase = (status?: string): Mode1Error =>
  new Mode1Error("IMPORT_INVALID_STATE", "Dự án chưa có nội dung để so - hãy tải tài liệu lên lần đầu trước.", {
    status: status ?? "uploaded",
    to: "uploaded",
    allowed: []
  })

/**
 * Bản đem so: sau baseline là file version mới nhất; trước baseline (dự án đang soạn) là đúng file tải về bản DRAFT của nội
 * dung đang soạn. Mode 1 chưa có version (đang đọc file, chưa có nội dung) ⇒ chưa so được.
 */
const comparisonBase = async (projectId: string, project: IProject): Promise<{ blocks: OoxmlBlock[]; version: string; beforeBaseline: boolean }> => {
  const version = await latestDocVersion(projectId)
  // FLF-457: trước / sau baseline theo việc dự án có version tài liệu thật (đã ký baseline), không theo `mode` — dự án chế độ 2,
  // hoặc chế độ 3/4 đã chuyển sang `fpt` sau khi ký baseline, cũng phải so với file version và tạo CR.
  if (version) {
    if (project.mode === "import") {
      const current = await latestImport(projectId)
      if (!current || !hasBaseline(current.status)) throw noBase(current?.status)
    }
    return { blocks: await fileBlocksOfVersion(version), version: version.version, beforeBaseline: false }
  }
  if (project.mode === "import") throw noBase((await latestImport(projectId))?.status)
  try {
    const draft = await renderExportDocx(await contextOf(projectId, project), { source: "draft" })
    return { blocks: await fileBlocks(draft.buffer), version: BEFORE_BASELINE_VERSION, beforeBaseline: true }
  } catch (err) {
    if (err instanceof NoWorkingDraftError) throw noBase()
    throw err
  }
}

export const reupload = async (projectId: string, userId: string, file: UploadedFile, project?: IProject): Promise<IReuploadDiff> => {
  const owner = project ?? (await Project.findById(projectId))
  if (!owner) throw noBase()
  const base = await comparisonBase(projectId, owner)
  // Upload lại: Track Changes / comment của người ngoài không bị từ chối, mỗi chỗ thành một dòng khác biệt
  const pre = await preflightDocx(file.buffer, { allowForeignMarkup: true })
  if (pre.stamp && pre.stamp.project_id !== projectId) {
    throw new Mode1Error("IMPORT_STAMP_FOREIGN_PROJECT", "File này được xuất từ một project FlintFlow khác", { stamp: pre.stamp })
  }
  if (pre.status === "rejected") {
    const current = await latestImport(projectId)
    throw new Mode1Error("IMPORT_FILE_REJECTED", "File chưa so được, xem danh sách lỗi", { ...(current ? { import_id: String(current._id) } : {}), issues: pre.issues })
  }

  const theirs = await fileBlocks(file.buffer)
  const { blocks, sections } = diffBlockLists(toDiffBlocks(base.blocks), toDiffBlocks(theirs))
  const noStamp = !pre.stamp
  const headingMatch = headingMatchRatio(base.blocks, theirs)
  // Dấu version cũ hơn bản hiện tại (chỉ khi có số version: bản DRAFT trước baseline không mang số)
  const fileVersion = pre.stamp?.version ?? null
  const stale =
    !base.beforeBaseline && fileVersion && isDocVersion(fileVersion) && isDocVersion(base.version) && compareDocVersions(fileVersion, base.version) < 0
      ? { file_version: fileVersion, current_version: base.version }
      : null
  const fileRef = await docFileStore().save(file.buffer, { projectId, kind: "reupload", name: file.originalname })
  return ReuploadDiff.create({
    projectId,
    file_ref: fileRef,
    sha256: createHash("sha256").update(file.buffer).digest("hex"),
    original_name: file.originalname,
    against_version: base.version,
    blocks,
    sections,
    before_baseline: base.beforeBaseline,
    no_stamp: noStamp,
    heading_match: headingMatch,
    suggest_reference: noStamp && headingMatch < REUPLOAD_HEADING_MATCH_MIN,
    stale,
    markup: pre.markup,
    created_by: userId
  })
}
