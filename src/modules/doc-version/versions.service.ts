/**
 * Đọc version tài liệu mode 1 qua API (UC-54 xem theo block, UC-55 so sánh, UC-57 tải về). FLF-171, plan §6 2F.
 * Mode 1 v2 (FLF-186): version là bản render từ Spine — block (#13) và so sánh (#15) đọc từ file của version, khớp theo
 * text (file render không mang bookmark neo); không còn Track Changes theo block.
 * Tải bản draft ⇒ file có Track Changes + watermark DRAFT (G8, chỉ bản tải về, không sửa file lưu),
 * tên `…_v0.2_DRAFT.docx`; bản release ⇒ bản sạch (accept-all) trừ khi xin `variant=tracked`.
 */

import { DocxPackage, addDraftWatermark, type OoxmlBlock } from "../docx-ooxml/index.js"
import type { DocBlockDto } from "../import/import.dto.js"
import { Mode1Error } from "../import/mode1.errors.js"
import { toIso } from "../import/mode1.http.js"
import { diffBlockLists } from "./block-diff.js"
import { docFileStore } from "./doc-file.store.js"
import type { CompareResponse, DocVersionDto } from "./doc-version.dto.js"
import type { IDocVersion } from "./doc-version.model.js"
import { fileBlocksOfVersion, listDocVersions, requireDocVersion } from "./doc-version.service.js"
import { downloadFileName, isReleaseVersion } from "./versioning.js"

export const toVersionDto = (v: IDocVersion): DocVersionDto => ({
  version: v.version,
  kind: v.kind,
  based_on: v.based_on ?? null,
  cr_ids: [...v.cr_ids],
  baseline_id: v.baseline_ref ?? null,
  has_clean_file: !!v.clean_file_ref,
  has_tracked_file: !!v.tracked_file_ref,
  has_original_file: !!v.original_ref,
  created_by: String(v.created_by),
  created_at: toIso(v.createdAt)!
})

export const listVersions = async (projectId: string): Promise<DocVersionDto[]> => (await listDocVersions(projectId)).map(toVersionDto)

const blockId = (i: number): string => `B${String(i + 1).padStart(4, "0")}`

/** Block của file version theo thứ tự tài liệu (id theo thứ tự đọc — chỉ để hiển thị, không phải neo). */
export const versionBlocks = async (projectId: string, version: string): Promise<DocBlockDto[]> => {
  const v = await requireDocVersion(projectId, version)
  return (await fileBlocksOfVersion(v)).map((b, i) => ({
    block_id: blockId(i),
    doc_version: v.version,
    kind: b.kind,
    level: b.level ?? null,
    heading_path: [...b.heading_path],
    text: b.text,
    section_id: null,
    mentions: [],
    editable: false,
    locked_by_cr: null
  }))
}

export interface DownloadFile {
  filename: string
  data: Buffer
}

export const downloadVersion = async (projectId: string, projectName: string, version: string, variant: "auto" | "tracked" | "original"): Promise<DownloadFile> => {
  const v = await requireDocVersion(projectId, version)
  if (variant === "original") {
    // Bản gốc người dùng upload (có stamp) — không watermark, tên theo version + hậu tố _original
    if (!v.original_ref) throw new Mode1Error("DOC_VERSION_NOT_FOUND", `Version ${v.version} không có file gốc (chỉ bản import 0.0)`)
    return { filename: downloadFileName(projectName, v.version).replace(/(_DRAFT)?.docx$/, "_original.docx"), data: await docFileStore().load(v.original_ref) }
  }
  const release = isReleaseVersion(v.version)
  if (release && variant === "auto" && v.clean_file_ref) {
    return { filename: downloadFileName(projectName, v.version), data: await docFileStore().load(v.clean_file_ref) }
  }
  // BPMN 3.14 (mode 1 v3): bản có đánh dấu của CR là file riêng; version không có (0.0, dựng lỗi) ⇒ bản render như cũ
  const data = await docFileStore().load(variant === "tracked" && v.tracked_file_ref ? v.tracked_file_ref : v.file_ref)
  if (release) return { filename: downloadFileName(projectName, v.version), data }
  const pkg = await DocxPackage.load(data)
  await addDraftWatermark(pkg)
  return { filename: downloadFileName(projectName, v.version), data: await pkg.toBuffer() }
}

export const compareVersions = async (projectId: string, from: string, to: string): Promise<CompareResponse> => {
  const [va, vb] = await Promise.all([requireDocVersion(projectId, from), requireDocVersion(projectId, to)])
  const [a, b] = await Promise.all([fileBlocksOfVersion(va), fileBlocksOfVersion(vb)])
  const lite = (x: OoxmlBlock[]) => x.map((blk) => ({ block_id: null, para_id: blk.para_id, text: blk.text, text_hash: blk.text_hash }))
  const { blocks, summary } = diffBlockLists(lite(a), lite(b))
  return { from, to, summary, blocks }
}
