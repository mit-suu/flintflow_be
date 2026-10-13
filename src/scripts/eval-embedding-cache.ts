/**
 * Cache embedding cho eval tri thức (FLF-267) — chỉ dùng trong script eval, không dùng ở luồng người dùng.
 *
 * Gemini free tier chỉ cho 1 000 text embed / ngày (mỗi text trong lô tính một lượt): một lượt `--retrieval-only` cần
 * ~670 text, chạy lại sau khi sửa câu hỏi / ngưỡng là hết quota. Cache theo khoá sha256(model | taskType | text) ghi ra
 * file JSONL sau từng nhóm nhỏ ⇒ lượt chạy hỏng giữa chừng (429 quota ngày) vẫn giữ phần đã embed, lượt sau chỉ embed
 * phần thiếu. `seedFromDb` nạp sẵn vector đã ingest ở `knowledge_chunks` (cùng `embed_text`, cùng model) ⇒ bộ chunk
 * chính không phải embed lại.
 */

import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { embedTexts, embeddingModelId, type EmbeddingTaskType } from "../shared/ai/embedding/embedding.provider.js"

/** Số text embed rồi ghi file một lần — nhỏ để quota ngày cắt giữa chừng mất ít nhất. */
export const CACHE_FLUSH_EVERY = 50

export const cacheKey = (model: string, taskType: EmbeddingTaskType, text: string): string =>
  createHash("sha256").update(`${model}\u0000${taskType}\u0000${text}`).digest("hex")

export interface EmbeddingCache {
  /** Embed giữ thứ tự; text đã có trong cache không gọi provider. */
  embed: (texts: readonly string[], taskType: EmbeddingTaskType) => Promise<number[][]>
  /** Nạp vector có sẵn (vd từ DB) — không ghi đè khoá đã có. Trả số khoá mới. */
  seed: (entries: readonly { text: string; taskType: EmbeddingTaskType; vector: number[] }[]) => number
  stats: () => { hits: number; misses: number; size: number }
}

type Embedder = (texts: string[], taskType: EmbeddingTaskType) => Promise<number[][]>

const defaultEmbedder: Embedder = (texts, taskType) => embedTexts(texts, { taskType, waitOnRateLimit: true })

/**
 * `file` = null ⇒ cache chỉ trong bộ nhớ (`--no-cache`). Dòng hỏng trong file bị bỏ qua (file ghi dở lúc bị dừng).
 */
export const createEmbeddingCache = (file: string | null, embedder: Embedder = defaultEmbedder, model = embeddingModelId()): EmbeddingCache => {
  const map = new Map<string, number[]>()
  if (file && fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue
      try {
        const { k, v } = JSON.parse(line) as { k: string; v: number[] }
        if (typeof k === "string" && Array.isArray(v)) map.set(k, v)
      } catch {
        // dòng ghi dở — bỏ
      }
    }
  }
  const append = (rows: [string, number[]][]): void => {
    if (!file || !rows.length) return
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, rows.map(([k, v]) => JSON.stringify({ k, v })).join("\n") + "\n")
  }
  let hits = 0
  let misses = 0
  return {
    embed: async (texts, taskType) => {
      const keys = texts.map((t) => cacheKey(model, taskType, t))
      const missing = [...new Set(keys.map((k, i) => (map.has(k) ? -1 : i)).filter((i) => i >= 0).map((i) => texts[i]!))]
      hits += texts.length - keys.filter((k) => !map.has(k)).length
      misses += missing.length
      for (let i = 0; i < missing.length; i += CACHE_FLUSH_EVERY) {
        const group = missing.slice(i, i + CACHE_FLUSH_EVERY)
        const vectors = await embedder(group, taskType)
        const rows = group.map((t, j) => [cacheKey(model, taskType, t), vectors[j]!] as [string, number[]])
        for (const [k, v] of rows) map.set(k, v)
        append(rows)
      }
      return keys.map((k) => map.get(k)!)
    },
    seed: (entries) => {
      const rows: [string, number[]][] = []
      for (const e of entries) {
        const k = cacheKey(model, e.taskType, e.text)
        if (map.has(k)) continue
        map.set(k, e.vector)
        rows.push([k, e.vector])
      }
      append(rows)
      return rows.length
    },
    stats: () => ({ hits, misses, size: map.size })
  }
}
