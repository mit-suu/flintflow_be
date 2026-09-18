/**
 * Đọc version tài liệu mode 1 (FLF-171): version mới nhất, block theo version, file theo version.
 * Ghi version mới ở finalize (0.0), C-7 (minor) và release (major).
 */

import mongoose from "mongoose"
import { DocBlock, type IDocBlock } from "../import/doc-block.model.js"
import { Mode1Error } from "../import/mode1.errors.js"
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

export const blocksOfVersion = async (projectId: string | mongoose.Types.ObjectId, version: string): Promise<IDocBlock[]> =>
  DocBlock.find({ projectId, doc_version: version }).sort({ "anchor.ordinal": 1 })
