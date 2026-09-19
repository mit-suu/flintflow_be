/**
 * Đọc version tài liệu mode 1 (FLF-171): version mới nhất, block theo version, file theo version.
 * Ghi version mới ở finalize (0.0), C-7 (minor) và release (major).
 * Mode 1 v2 (FLF-186): mỗi version là bản **render** từ Spine — block của version đọc thẳng từ file của nó
 * (`fileBlocksOfVersion`), không còn bản sao `DocBlock` theo version.
 */

import mongoose from "mongoose"
import { DocxPackage, readBlocks, type OoxmlBlock } from "../docx-ooxml/index.js"
import { Mode1Error } from "../import/mode1.errors.js"
import { docFileStore } from "./doc-file.store.js"
import { DocVersion, type IDocVersion } from "./doc-version.model.js"
import { compareDocVersions } from "./versioning.js"

export const listDocVersions = async (projectId: string | mongoose.Types.ObjectId): Promise<IDocVersion[]> => {
  const all = await DocVersion.find({ projectId })
  return all.sort((a, b) => compareDocVersions(b.version, a.version))
}

export const latestDocVersion = async (projectId: string | mongoose.Types.ObjectId): Promise<IDocVersion | null> =>
  (await listDocVersions(projectId))[0] ?? null

export const requireDocVersion = async (projectId: string | mongoose.Types.ObjectId, version: string): Promise<IDocVersion> => {
  const doc = await DocVersion.findOne({ projectId, version })
  if (!doc) throw new Mode1Error("DOC_VERSION_NOT_FOUND", `Không có version ${version}`)
  return doc
}

/** Block đọc từ file của version (ô bảng bỏ — text đã nằm trong khối bảng). */
export const fileBlocks = async (data: Buffer): Promise<OoxmlBlock[]> =>
  (await readBlocks(await DocxPackage.load(data))).filter((b) => b.kind !== "table_cell" && b.kind !== "table_row")

export const fileBlocksOfVersion = async (version: IDocVersion): Promise<OoxmlBlock[]> => fileBlocks(await docFileStore().load(version.file_ref))
