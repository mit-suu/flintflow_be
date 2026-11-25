/**
 * Lưu bản có Track Changes của một version (FLF-484, lát A): so file mốc với file mới, lưu riêng.
 * Lỗi ⇒ `null` — ghi CR / phát hành không phụ thuộc bản này. Cùng thân với `saveTracked` của `write.service.ts`.
 */

import { docFileStore } from "./doc-file.store.js"
import { buildTrackedDocx, type TrackedComment } from "./tracked-version.js"

export interface SaveTrackedOptions {
  /** Tên file lưu trong kho (không gồm đuôi). */
  name: string
  author: string
  date: Date
  comments?: readonly TrackedComment[]
  contentOnly?: boolean
}

export const saveTrackedFile = async (projectId: string, prevRef: string, file: Buffer, opts: SaveTrackedOptions): Promise<string | null> => {
  try {
    const out = await buildTrackedDocx(await docFileStore().load(prevRef), file, { author: opts.author, date: opts.date }, opts.comments ?? [], { contentOnly: opts.contentOnly ?? false })
    return await docFileStore().save(out.data, { projectId, kind: "version", name: opts.name })
  } catch (err) {
    console.warn(`[release] ${projectId}: dựng bản có đánh dấu của ${opts.name} lỗi - chỉ còn bản sạch`, err)
    return null
  }
}

/** Tác giả của bản đánh dấu gộp: mã CR của gói; quá 5 CR thì rút gọn. */
export const releaseTrackedAuthor = (crIds: readonly string[], version: string): string => {
  if (crIds.length === 0) return `FlintFlow ${version}`
  if (crIds.length <= 5) return crIds.join(", ")
  return `${crIds[0]} … ${crIds[crIds.length - 1]} (${crIds.length} CR)`
}
