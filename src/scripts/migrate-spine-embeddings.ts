/**
 * Hybrid retrieval C-3 — dựng index embedding phần tử Spine cho DB Atlas đã có project mode 1.
 *
 * Cách dùng:
 *   npm run migrate:spine-embeddings -- --dry-run          # chỉ in việc sẽ làm
 *   npm run migrate:spine-embeddings -- --index-only       # chỉ tạo collection + Atlas Vector Search index
 *   npm run migrate:spine-embeddings                       # tạo (nếu thiếu) rồi embed mọi project mode `import`
 *
 * Idempotent: collection / index có rồi thì bỏ qua (index khác định nghĩa ⇒ chỉ báo, không tự xoá); backfill chỉ embed
 * phần tử đổi `text_hash` nên chạy lại chỉ tốn phần mới. Cần `EMBEDDING_PROVIDER=gemini` + `GEMINI_API_KEY` và Mongo
 * Atlas (Mongo khác không có search index ⇒ script dừng ở bước 2). Embedding không trừ credit của org.
 */

import mongoose from "mongoose"
import { pathToFileURL } from "node:url"
import { env } from "../config/env.js"
import { embeddingAvailable, embeddingModelId } from "../shared/ai/embedding/embedding.provider.js"
import { syncProjectEmbeddings } from "../modules/change-request/embedding/embedding-sync.service.js"
import { SPINE_EMBEDDING_COLLECTION, SPINE_EMBEDDING_INDEX } from "../modules/change-request/embedding/spine-embedding.model.js"
import { Project } from "../modules/project/project.model.js"

/** Field lọc của `$vectorSearch` — `vector-search.ts` lọc `projectId` + `kind`, hai field còn lại để dành. */
export const VECTOR_FILTER_FIELDS = ["projectId", "kind", "entity", "spine_version"] as const

/** Định nghĩa Atlas Vector Search index — khớp index `spine_embeddings_vector` đã tạo tay trên DB dev. */
export const vectorIndexDefinition = (dimensions: number) => ({
  fields: [
    { type: "vector", path: "embedding", numDimensions: dimensions, similarity: "cosine" },
    ...VECTOR_FILTER_FIELDS.map((path) => ({ type: "filter", path }))
  ]
})

interface SearchIndexInfo {
  name: string
  latestDefinition?: { fields?: { type: string; path: string; numDimensions?: number }[] }
}

/** Index đang có lệch định nghĩa ⇒ mô tả lệch (để báo), khớp ⇒ null. */
export const definitionDrift = (existing: SearchIndexInfo, dimensions: number): string | null => {
  const fields = existing.latestDefinition?.fields ?? []
  const vector = fields.find((f) => f.type === "vector")
  if (!vector || vector.path !== "embedding") return "thiếu field vector `embedding`"
  if (vector.numDimensions !== dimensions) return `vector ${vector.numDimensions} chiều, EMBEDDING_DIMENSIONS=${dimensions}`
  const filters = new Set(fields.filter((f) => f.type === "filter").map((f) => f.path))
  const missing = VECTOR_FILTER_FIELDS.filter((f) => !filters.has(f))
  return missing.length ? `thiếu field lọc ${missing.join(", ")}` : null
}

const main = async (): Promise<void> => {
  const dryRun = process.argv.includes("--dry-run")
  const indexOnly = process.argv.includes("--index-only")
  await mongoose.connect(env.MONGO_URI)
  console.log(`🟢 Connected to MongoDB${dryRun ? " (dry-run: không ghi)" : ""}`)
  const db = mongoose.connection.db!
  try {
    // 1. Collection
    const exists = (await db.listCollections({ name: SPINE_EMBEDDING_COLLECTION }).toArray()).length > 0
    if (!exists) {
      if (dryRun) console.log(`sẽ tạo collection ${SPINE_EMBEDDING_COLLECTION}`)
      else {
        await db.createCollection(SPINE_EMBEDDING_COLLECTION)
        console.log(`đã tạo collection ${SPINE_EMBEDDING_COLLECTION}`)
      }
    }

    // 2. Atlas Vector Search index
    const collection = db.collection(SPINE_EMBEDDING_COLLECTION)
    const indexes = exists ? ((await collection.listSearchIndexes().toArray()) as unknown as SearchIndexInfo[]) : []
    const current = indexes.find((i) => i.name === SPINE_EMBEDDING_INDEX)
    if (current) {
      const drift = definitionDrift(current, env.EMBEDDING_DIMENSIONS)
      console.log(drift ? `⚠ index ${SPINE_EMBEDDING_INDEX} lệch định nghĩa (${drift}) — sửa tay trên Atlas` : `index ${SPINE_EMBEDDING_INDEX} đã có`)
    } else if (dryRun) {
      console.log(`sẽ tạo vector search index ${SPINE_EMBEDDING_INDEX}: ${JSON.stringify(vectorIndexDefinition(env.EMBEDDING_DIMENSIONS))}`)
    } else {
      await collection.createSearchIndex({ name: SPINE_EMBEDDING_INDEX, type: "vectorSearch", definition: vectorIndexDefinition(env.EMBEDDING_DIMENSIONS) })
      console.log(`đã tạo vector search index ${SPINE_EMBEDDING_INDEX} (Atlas dựng nền vài phút — trong lúc đó C-3 dùng từ khoá)`)
    }
    if (indexOnly) return

    // 3. Backfill
    const projects = await Project.find({ mode: "import" }).select("_id name").lean()
    if (dryRun) {
      console.log(`sẽ embed phần tử Spine của ${projects.length} project mode import (model ${embeddingModelId()})`)
      return
    }
    if (!embeddingAvailable()) {
      console.log("Embedding chưa bật (EMBEDDING_PROVIDER=off hoặc thiếu GEMINI_API_KEY) — bỏ qua backfill")
      return
    }
    let total = 0
    for (const p of projects) {
      try {
        const res = await syncProjectEmbeddings(String(p._id))
        if (!res) {
          console.log(`${p._id}: bỏ qua (không có Spine hoặc Mongo không có $vectorSearch)`)
          continue
        }
        total += res.embedded
        console.log(`${p._id} ${p.name}: embed ${res.embedded}, xoá ${res.removed}, giữ ${res.kept}`)
      } catch (err) {
        console.error(`${p._id}: lỗi — ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    console.log(`Xong: ${projects.length} project, embed ${total} phần tử`)
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
