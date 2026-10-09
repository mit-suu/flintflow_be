/**
 * Knowledge RAG (FLF-267) — dựng collection + index cho `knowledge_chunks`.
 *
 * Cách dùng:
 *   npm run migrate:knowledge-index -- --dry-run     # chỉ in việc sẽ làm
 *   npm run migrate:knowledge-index                  # tạo collection, text index, Atlas Vector Search index nếu thiếu
 *
 * Idempotent: thứ đã có thì bỏ qua. Index đã có mà lệch định nghĩa ⇒ **chỉ báo**, không bao giờ sửa / xoá index đang có
 * (xoá index vector là mất tìm kiếm tới khi Atlas dựng lại — việc đó phải làm tay, có chủ đích).
 * Mongo không phải Atlas (local, in-memory, community không mongot) ⇒ bước vector index báo "không hỗ trợ" rồi đi tiếp;
 * retrieval khi đó dùng backend `memory`. Nạp dữ liệu: `npm run ingest:knowledge`.
 */

import mongoose from "mongoose"
import { pathToFileURL } from "node:url"
import { env } from "../config/env.js"
import {
  KNOWLEDGE_CHUNK_COLLECTION,
  KNOWLEDGE_TEXT_INDEX,
  KNOWLEDGE_TEXT_INDEX_WEIGHTS,
  KNOWLEDGE_VECTOR_INDEX
} from "../modules/knowledge/knowledge-chunk.model.js"
import { isVectorSearchUnsupported } from "../modules/knowledge/vector-backend.js"

/** Field lọc của `$vectorSearch` — `vector-backend.ts` lọc `corpus`, `status`, `applies_to`; `source_kind` để dành. */
export const VECTOR_FILTER_FIELDS = ["corpus", "status", "source_kind", "applies_to"] as const

export const vectorIndexDefinition = (dimensions: number) => ({
  fields: [
    { type: "vector", path: "embedding", numDimensions: dimensions, similarity: "cosine" },
    ...VECTOR_FILTER_FIELDS.map((path) => ({ type: "filter", path }))
  ]
})

export const textIndexKey = { section: "text", embed_text: "text" } as const
export const textIndexOptions = { name: KNOWLEDGE_TEXT_INDEX, weights: { ...KNOWLEDGE_TEXT_INDEX_WEIGHTS }, default_language: "english" }

interface SearchIndexInfo {
  name: string
  latestDefinition?: { fields?: { type: string; path: string; numDimensions?: number; similarity?: string }[] }
}

/** Index vector đang có lệch định nghĩa ⇒ mô tả lệch, khớp ⇒ null. */
export const vectorDefinitionDrift = (existing: SearchIndexInfo, dimensions: number): string | null => {
  const fields = existing.latestDefinition?.fields ?? []
  const vector = fields.find((f) => f.type === "vector")
  if (!vector || vector.path !== "embedding") return "thiếu field vector `embedding`"
  if (vector.numDimensions !== dimensions) return `vector ${vector.numDimensions} chiều, EMBEDDING_DIMENSIONS=${dimensions}`
  if (vector.similarity && vector.similarity !== "cosine") return `similarity ${vector.similarity}, cần cosine`
  const filters = new Set(fields.filter((f) => f.type === "filter").map((f) => f.path))
  const missing = VECTOR_FILTER_FIELDS.filter((f) => !filters.has(f))
  return missing.length ? `thiếu field lọc ${missing.join(", ")}` : null
}

interface IndexInfo {
  name?: string
  key: Record<string, unknown>
  weights?: Record<string, number>
  default_language?: string
}

/** Text index đang có lệch (trọng số / ngôn ngữ / field) ⇒ mô tả lệch, khớp ⇒ null. */
export const textIndexDrift = (existing: IndexInfo): string | null => {
  const weights = existing.weights ?? {}
  const expected: Record<string, number> = { ...KNOWLEDGE_TEXT_INDEX_WEIGHTS }
  const diff = [...new Set([...Object.keys(weights), ...Object.keys(expected)])].filter((k) => weights[k] !== expected[k])
  if (diff.length) return `trọng số khác (${diff.map((k) => `${k}: ${weights[k] ?? "—"} ≠ ${expected[k] ?? "—"}`).join(", ")})`
  if ((existing.default_language ?? "english") !== "english") return `default_language ${existing.default_language}, cần english`
  return null
}

export type StepOutcome = "exists" | "created" | "would_create" | "drift" | "unsupported" | "blocked"

export interface MigrateReport {
  collection: StepOutcome
  text_index: StepOutcome
  vector_index: StepOutcome
  messages: string[]
}

export interface MigrateOptions {
  dryRun: boolean
  dimensions: number
  log?: (line: string) => void
}

export const migrateKnowledgeIndex = async (db: mongoose.mongo.Db, options: MigrateOptions): Promise<MigrateReport> => {
  const messages: string[] = []
  const log = (line: string): void => {
    messages.push(line)
    options.log?.(line)
  }
  const report: MigrateReport = { collection: "exists", text_index: "exists", vector_index: "exists", messages }

  // 1. Collection
  const exists = (await db.listCollections({ name: KNOWLEDGE_CHUNK_COLLECTION }).toArray()).length > 0
  if (!exists) {
    if (options.dryRun) {
      report.collection = "would_create"
      log(`sẽ tạo collection ${KNOWLEDGE_CHUNK_COLLECTION}`)
    } else {
      await db.createCollection(KNOWLEDGE_CHUNK_COLLECTION)
      report.collection = "created"
      log(`đã tạo collection ${KNOWLEDGE_CHUNK_COLLECTION}`)
    }
  } else log(`collection ${KNOWLEDGE_CHUNK_COLLECTION} đã có`)
  const collection = db.collection(KNOWLEDGE_CHUNK_COLLECTION)

  // 2. Text index — mỗi collection chỉ được MỘT text index
  const indexes = exists ? ((await collection.indexes()) as IndexInfo[]) : []
  const textIndexes = indexes.filter((i) => Object.values(i.key).includes("text") || "_fts" in i.key)
  const ours = textIndexes.find((i) => i.name === KNOWLEDGE_TEXT_INDEX)
  if (ours) {
    const drift = textIndexDrift(ours)
    report.text_index = drift ? "drift" : "exists"
    log(drift ? `⚠ text index ${KNOWLEDGE_TEXT_INDEX} lệch định nghĩa (${drift}) — sửa tay (drop rồi chạy lại script)` : `text index ${KNOWLEDGE_TEXT_INDEX} đã có`)
  } else if (textIndexes.length) {
    report.text_index = "blocked"
    log(`⚠ collection đã có text index khác (${textIndexes.map((i) => i.name).join(", ")}) — Mongo chỉ cho một text index, không tạo ${KNOWLEDGE_TEXT_INDEX}`)
  } else if (options.dryRun) {
    report.text_index = "would_create"
    log(`sẽ tạo text index ${KNOWLEDGE_TEXT_INDEX}: ${JSON.stringify({ key: textIndexKey, ...textIndexOptions })}`)
  } else {
    await collection.createIndex({ ...textIndexKey }, textIndexOptions)
    report.text_index = "created"
    log(`đã tạo text index ${KNOWLEDGE_TEXT_INDEX}`)
  }

  // 3. Atlas Vector Search index
  const definition = vectorIndexDefinition(options.dimensions)
  let searchIndexes: SearchIndexInfo[] = []
  try {
    searchIndexes = exists ? ((await collection.listSearchIndexes().toArray()) as unknown as SearchIndexInfo[]) : []
  } catch (err) {
    if (!isVectorSearchUnsupported(err)) throw err
    report.vector_index = "unsupported"
    log(`Mongo này không có Atlas Search (không phải Atlas) — bỏ qua vector index ${KNOWLEDGE_VECTOR_INDEX}; retrieval sẽ dùng backend memory`)
    return report
  }
  const current = searchIndexes.find((i) => i.name === KNOWLEDGE_VECTOR_INDEX)
  if (current) {
    const drift = vectorDefinitionDrift(current, options.dimensions)
    report.vector_index = drift ? "drift" : "exists"
    log(drift ? `⚠ vector index ${KNOWLEDGE_VECTOR_INDEX} lệch định nghĩa (${drift}) — sửa tay trên Atlas` : `vector index ${KNOWLEDGE_VECTOR_INDEX} đã có`)
  } else if (options.dryRun) {
    report.vector_index = "would_create"
    log(`sẽ tạo vector search index ${KNOWLEDGE_VECTOR_INDEX}: ${JSON.stringify(definition)}`)
  } else {
    try {
      await collection.createSearchIndex({ name: KNOWLEDGE_VECTOR_INDEX, type: "vectorSearch", definition })
      report.vector_index = "created"
      log(`đã tạo vector search index ${KNOWLEDGE_VECTOR_INDEX} (Atlas dựng nền vài phút — trong lúc đó retrieval chỉ có từ khoá / memory)`)
    } catch (err) {
      if (!isVectorSearchUnsupported(err)) throw err
      report.vector_index = "unsupported"
      log(`Mongo này không tạo được search index — bỏ qua ${KNOWLEDGE_VECTOR_INDEX}; retrieval sẽ dùng backend memory`)
    }
  }
  return report
}

const main = async (): Promise<void> => {
  const dryRun = process.argv.includes("--dry-run")
  // Không dùng connectDB: nó còn khởi tạo replica set và tài khoản admin — script không được có tác dụng phụ đó.
  // Dry-run tắt autoIndex: model đã import thì mongoose tự tạo collection + index lúc kết nối, dry-run sẽ không còn là chỉ đọc
  await mongoose.connect(env.MONGO_URI, { autoIndex: !dryRun, autoCreate: !dryRun })
  console.log(`🟢 Connected to MongoDB${dryRun ? " (dry-run: không ghi)" : ""}`)
  try {
    await migrateKnowledgeIndex(mongoose.connection.db!, { dryRun, dimensions: env.EMBEDDING_DIMENSIONS, log: (l) => console.log(l) })
  } finally {
    await mongoose.disconnect()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
