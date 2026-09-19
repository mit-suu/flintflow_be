/**
 * Re-upload sau baseline (nút 1.4, UC-24): so file mới với version tài liệu mới nhất theo block, **không** tạo
 * version. Người dùng xem diff rồi (tuỳ) tạo CR nguồn `reupload`. FLF-171, plan §6 2D.
 * - Stamp của project khác ⇒ `IMPORT_STAMP_FOREIGN_PROJECT`.
 * - File không stamp vẫn so được (khớp theo paraId + text) — người dùng tự chịu việc file có phải bản gốc hay không.
 */

import { createHash } from "node:crypto"
import { DocxPackage, blockIdOfBookmark, readBlocks } from "../docx-ooxml/index.js"
import { diffBlockLists } from "../doc-version/block-diff.js"
import { docFileStore } from "../doc-version/doc-file.store.js"
import { blocksOfVersion, latestDocVersion } from "../doc-version/doc-version.service.js"
import type { ReuploadDiffDto } from "./import.dto.js"
import { hasBaseline } from "./import.state.js"
import { latestImport, type UploadedFile } from "./import.service.js"
import { Mode1Error } from "./mode1.errors.js"
import { toIso } from "./mode1.http.js"
import { preflightDocx } from "./preflight.service.js"
import { ReuploadDiff, type IReuploadDiff } from "./reupload-diff.model.js"

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
      ...(b.after !== undefined ? { after: b.after } : {})
    }))
  }
}

export const reupload = async (projectId: string, userId: string, file: UploadedFile): Promise<IReuploadDiff> => {
  const current = await latestImport(projectId)
  const version = await latestDocVersion(projectId)
  if (!current || !hasBaseline(current.status) || !version) {
    throw new Mode1Error("IMPORT_INVALID_STATE", "Chưa có baseline v0 — dùng /import cho lần upload đầu", {
      status: current?.status ?? "uploaded",
      to: "uploaded",
      allowed: []
    })
  }
  const pre = await preflightDocx(file.buffer)
  if (pre.stamp && pre.stamp.project_id !== projectId) {
    throw new Mode1Error("IMPORT_STAMP_FOREIGN_PROJECT", "File này được xuất từ một project FlintFlow khác", { stamp: pre.stamp })
  }
  if (pre.status === "rejected") {
    throw new Mode1Error("IMPORT_FILE_REJECTED", "File chưa so được, xem danh sách lỗi", { import_id: String(current._id), issues: pre.issues })
  }

  const newBlocks = await readBlocks(await DocxPackage.load(file.buffer))
  const oldBlocks = await blocksOfVersion(projectId, version.version)
  const { blocks } = diffBlockLists(
    oldBlocks.map((b) => ({ block_id: b.block_id, para_id: b.anchor.para_id, text: b.text, text_hash: b.text_hash })),
    newBlocks.map((b) => ({ block_id: blockIdOfBookmark(b.bookmark), para_id: b.para_id, text: b.text, text_hash: b.text_hash }))
  )
  const fileRef = await docFileStore().save(file.buffer, { projectId, kind: "reupload", name: file.originalname })
  return ReuploadDiff.create({
    projectId,
    file_ref: fileRef,
    sha256: createHash("sha256").update(file.buffer).digest("hex"),
    original_name: file.originalname,
    against_version: version.version,
    blocks,
    created_by: userId
  })
}
