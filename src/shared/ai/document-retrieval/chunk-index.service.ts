/**
 * Chunk + index BM25 của tài liệu upload theo project (FLF-393).
 *
 * - Chunk lưu ở `project_document_chunks`, dựng lúc upload (`saveDocumentChunks`); tài liệu cũ / lệch `CHUNKER_VERSION`
 *   được dựng bù ngay lần đầu cần tới — không cần chạy migration.
 * - Index BM25 nằm trong RAM, cache LRU theo tập tài liệu của project. `extractedText` không đổi sau khi parse (upload
 *   lại là tài liệu mới, id mới) nên khoá cache là `documentId` + `docCode` + `CHUNKER_VERSION`, không cần băm nội dung:
 *   thêm / xoá tài liệu đổi khoá ⇒ index dựng lại. Server và worker mỗi process một cache (dựng lại tốn mili giây).
 */

import mongoose from "mongoose"
import { ProjectDocument } from "../../../modules/project/project-document.model.js"
import { ProjectDocumentChunk } from "../../../modules/project/project-document-chunk.model.js"
import { splitParagraphs } from "../document-paragraphs.js"
import { buildBm25, type Bm25Index } from "./bm25.js"
import { CHUNKER_VERSION, chunkParagraphs, type DocumentChunk, type OutlineEntry } from "./chunker.js"
import { tokenize } from "./vi-tokenizer.js"

export interface IndexedDocumentRef {
  id: string
  docCode: number
  name: string
}

export interface IndexedChunk extends DocumentChunk {
  /** `<documentId>:<ordinal>`. */
  id: string
  documentId: string
  docCode: number
  docName: string
}

export interface ProjectChunkIndex {
  /** Theo thứ tự tài liệu (thứ tự `docs` truyền vào), rồi thứ tự chunk. */
  chunks: IndexedChunk[]
  bm25: Bm25Index
}

/** Chữ để chấm BM25: tiêu đề mục (kể cả mục cha) + thân chunk. */
const searchText = (chunk: DocumentChunk): string => `${chunk.titles.join("\n")}\n${chunk.paragraphs.join("\n")}`

/** Phần thuần: ghép chunk của các tài liệu thành một index. */
export const buildProjectIndex = (docs: readonly { ref: IndexedDocumentRef; chunks: readonly DocumentChunk[] }[]): ProjectChunkIndex => {
  const chunks: IndexedChunk[] = docs.flatMap(({ ref, chunks: list }) =>
    list.map((c) => ({ ...c, id: `${ref.id}:${c.ordinal}`, documentId: ref.id, docCode: ref.docCode, docName: ref.name }))
  )
  return { chunks, bm25: buildBm25(chunks.map((c) => ({ id: c.id, text: searchText(c) })), tokenize) }
}

// ─── cache ───────────────────────────────────────────────────────

/** Số project giữ index trong RAM. */
export const INDEX_CACHE_SIZE = 20
const cache = new Map<string, ProjectChunkIndex>()

const cacheKey = (docs: readonly IndexedDocumentRef[]): string => `v${CHUNKER_VERSION}|${docs.map((d) => `${d.id}:${d.docCode}`).join("|")}`

export const clearChunkIndexCache = (): void => cache.clear()

// ─── DB ──────────────────────────────────────────────────────────

const toChunk = (row: { ordinal: number; heading_path: string[]; titles: string[]; p_start: number; p_end: number; paragraphs: string[]; tokens: number }): DocumentChunk => ({
  ordinal: row.ordinal,
  heading_path: row.heading_path,
  titles: row.titles,
  p_start: row.p_start,
  p_end: row.p_end,
  paragraphs: row.paragraphs,
  tokens: row.tokens
})

/**
 * Cắt và lưu chunk của một tài liệu (ghi đè bản cũ). Lỗi ghi (vd hai request cùng dựng bù ⇒ trùng khoá) không ném:
 * chunk vừa cắt vẫn được trả về để dùng ngay, lần sau dựng lại.
 */
export const saveDocumentChunks = async (
  projectId: string | mongoose.Types.ObjectId,
  documentId: string | mongoose.Types.ObjectId,
  extractedText: string,
  outline: readonly OutlineEntry[] = []
): Promise<DocumentChunk[]> => {
  const chunks = chunkParagraphs(splitParagraphs(extractedText), outline)
  try {
    await ProjectDocumentChunk.deleteMany({ documentId })
    if (chunks.length) {
      await ProjectDocumentChunk.insertMany(
        chunks.map((c) => ({ ...c, projectId, documentId, chunker_version: CHUNKER_VERSION })),
        { ordered: false }
      )
    }
  } catch (err) {
    console.warn(`[DocumentChunks] Không lưu được chunk của tài liệu ${String(documentId)}: ${err instanceof Error ? err.message : String(err)}`)
  }
  return chunks
}

export const deleteDocumentChunks = async (documentId: string | mongoose.Types.ObjectId): Promise<void> => {
  await ProjectDocumentChunk.deleteMany({ documentId })
}

/** Index của tập tài liệu `docs` (đã parse xong, có `docCode`); tài liệu chưa có chunk đúng phiên bản được dựng bù. */
export const loadProjectIndex = async (docs: readonly IndexedDocumentRef[]): Promise<ProjectChunkIndex> => {
  const key = cacheKey(docs)
  const cached = cache.get(key)
  if (cached) {
    // LRU: đưa về cuối
    cache.delete(key)
    cache.set(key, cached)
    return cached
  }

  const rows = await ProjectDocumentChunk.find({ documentId: { $in: docs.map((d) => d.id) }, chunker_version: CHUNKER_VERSION })
    .sort({ documentId: 1, ordinal: 1 })
    .lean()
  const byDocument = new Map<string, DocumentChunk[]>()
  for (const row of rows) {
    const id = String(row.documentId)
    if (!byDocument.has(id)) byDocument.set(id, [])
    byDocument.get(id)!.push(toChunk(row))
  }

  const parts: { ref: IndexedDocumentRef; chunks: DocumentChunk[] }[] = []
  for (const ref of docs) {
    let chunks = byDocument.get(ref.id)
    if (!chunks) {
      const doc = await ProjectDocument.findById(ref.id).select("projectId extractedText outline").lean()
      chunks = doc?.extractedText ? await saveDocumentChunks(doc.projectId, ref.id, doc.extractedText, doc.outline ?? []) : []
    }
    parts.push({ ref, chunks })
  }

  const index = buildProjectIndex(parts)
  cache.set(key, index)
  if (cache.size > INDEX_CACHE_SIZE) cache.delete(cache.keys().next().value as string)
  return index
}
