/**
 * Đọc version tài liệu mode 1 qua API (UC-54 xem theo block, UC-55 so sánh, UC-57 tải về). FLF-171, plan §6 2F.
 * Tải bản draft ⇒ file có Track Changes + watermark DRAFT (G8, chỉ bản tải về, không sửa file lưu),
 * tên `…_v0.2_DRAFT.docx`; bản release ⇒ bản sạch (accept-all) trừ khi xin `variant=tracked`.
 */

import { DocxPackage, addDraftWatermark, blockIdOfBookmark, paragraphRevisions, readBlocks } from "../docx-ooxml/index.js"
import type { DocBlockDto } from "../import/import.dto.js"
import { toIso } from "../import/mode1.http.js"
import { diffBlockLists } from "./block-diff.js"
import { toDocBlockDto } from "./block-dto.js"
import { docFileStore } from "./doc-file.store.js"
import type { CompareResponse, DocVersionDto } from "./doc-version.dto.js"
import type { IDocVersion } from "./doc-version.model.js"
import { blocksOfVersion, listDocVersions, requireDocVersion } from "./doc-version.service.js"
import { downloadFileName, isReleaseVersion } from "./versioning.js"

export const toVersionDto = (v: IDocVersion): DocVersionDto => ({
  version: v.version,
  kind: v.kind,
  based_on: v.based_on ?? null,
  cr_ids: [...v.cr_ids],
  baseline_id: v.baseline_ref ?? null,
  has_clean_file: !!v.clean_file_ref,
  created_by: String(v.created_by),
  created_at: toIso(v.createdAt)!
})

export const listVersions = async (projectId: string): Promise<DocVersionDto[]> => (await listDocVersions(projectId)).map(toVersionDto)

/** Block theo thứ tự tài liệu; bản có Track Changes kèm `revisions[]` từng block. */
export const versionBlocks = async (projectId: string, version: string): Promise<DocBlockDto[]> => {
  const v = await requireDocVersion(projectId, version)
  const blocks = await blocksOfVersion(projectId, version)
  const revisionsOf = new Map<string, DocBlockDto["revisions"]>()
  if (v.kind === "cr_revision") {
    const ooxml = await readBlocks(await DocxPackage.load(await docFileStore().load(v.file_ref)))
    for (const b of ooxml) {
      const id = blockIdOfBookmark(b.bookmark)
      if (!id) continue
      const revs = paragraphRevisions(b.element)
      if (revs.length) revisionsOf.set(id, revs)
    }
  }
  return blocks.map((b) => toDocBlockDto(b, revisionsOf.get(b.block_id)))
}

export interface DownloadFile {
  filename: string
  data: Buffer
}

export const downloadVersion = async (projectId: string, projectName: string, version: string, variant: "auto" | "tracked"): Promise<DownloadFile> => {
  const v = await requireDocVersion(projectId, version)
  const release = isReleaseVersion(v.version)
  if (release && variant === "auto" && v.clean_file_ref) {
    return { filename: downloadFileName(projectName, v.version), data: await docFileStore().load(v.clean_file_ref) }
  }
  const data = await docFileStore().load(v.file_ref)
  if (release) return { filename: downloadFileName(projectName, v.version), data }
  const pkg = await DocxPackage.load(data)
  await addDraftWatermark(pkg)
  return { filename: downloadFileName(projectName, v.version), data: await pkg.toBuffer() }
}

export const compareVersions = async (projectId: string, from: string, to: string): Promise<CompareResponse> => {
  await Promise.all([requireDocVersion(projectId, from), requireDocVersion(projectId, to)])
  const [a, b] = await Promise.all([blocksOfVersion(projectId, from), blocksOfVersion(projectId, to)])
  const lite = (x: typeof a) => x.map((blk) => ({ block_id: blk.block_id, para_id: blk.anchor.para_id, text: blk.text, text_hash: blk.text_hash }))
  const { blocks, summary } = diffBlockLists(lite(a), lite(b))
  return { from, to, summary, blocks }
}
