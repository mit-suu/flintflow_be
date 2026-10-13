/**
 * Knowledge RAG (FLF-267) — nạp một corpus vào `knowledge_chunks`.
 *
 * Cách dùng:
 *   npm run ingest:knowledge -- --dir assets/skills --corpus skills --dry-run   # chỉ chunk + in thống kê: không embed, không nối DB
 *   npm run ingest:knowledge -- --dir assets/skills --corpus skills             # embed phần mới/đổi, upsert, xoá chunk đã mất
 *
 * Chạy thật cần `EMBEDDING_PROVIDER=gemini` + `GEMINI_API_KEY` (không trừ credit) và nên chạy
 * `npm run migrate:knowledge-index` trước. Chạy lại chỉ embed chunk đổi `text_hash`.
 * Mặc định `--dir` = `KNOWLEDGE_CORPUS_DIR`, `--corpus` = tên thư mục.
 */

import mongoose from "mongoose"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { env } from "../config/env.js"
import { embeddingAvailable, embeddingModelId } from "../shared/ai/embedding/embedding.provider.js"
import { chunkCorpus, chunkStats, type ChunkStats } from "../modules/knowledge/chunker.js"
import { loadCorpus } from "../modules/knowledge/corpus.js"
import type { IngestSummary } from "../modules/knowledge/ingest.js"

export interface IngestArgs {
  dir: string
  corpus: string
  dryRun: boolean
}

export const parseIngestArgs = (argv: readonly string[]): IngestArgs => {
  let dir = env.KNOWLEDGE_CORPUS_DIR
  let corpus: string | null = null
  let dryRun = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === "--dir") dir = argv[++i] ?? dir
    else if (a === "--corpus") corpus = argv[++i] ?? null
    else if (a === "--dry-run") dryRun = true
    else throw new Error(`Cờ không nhận ra: ${a}`)
  }
  return { dir, corpus: corpus ?? path.basename(path.resolve(dir)), dryRun }
}

export const formatChunkStats = (stats: ChunkStats): string[] => [
  `tài liệu: ${stats.documents} · chunk: ${stats.chunks} · token (ước lượng ký tự/3,5): tổng ${stats.tokens.total}, p50 ${stats.tokens.p50}, p90 ${stats.tokens.p90}, max ${stats.tokens.max}, min ${stats.tokens.min}`,
  `gộp (chunk chứa ≥ 2 section): ${stats.merged} · section bị cắt: ${stats.split_sections} (thành ${stats.split_chunks} chunk)`,
  ...stats.oversized.map((w) => `⚠ ${w.chunk_id}: ${w.tokens} token — ${w.message}`)
]

export const formatIngestSummary = (s: IngestSummary): string =>
  `corpus ${s.corpus} (model ${s.model}): ${s.chunks} chunk · embed ${s.embedded} (~${s.embedded_tokens} token) · giữ ${s.unchanged} · xoá ${s.deleted} · tổng ~${s.tokens} token chữ`

/** Trả mã thoát; `log` để test bắt output. Dry-run không nối Mongo, không gọi embedding. */
export const runIngest = async (args: IngestArgs, log: (line: string) => void = console.log): Promise<number> => {
  const docs = loadCorpus(args.dir, { corpus: args.corpus })
  const result = chunkCorpus(docs)
  log(`Corpus "${args.corpus}" từ ${path.resolve(args.dir)}`)
  for (const line of formatChunkStats(chunkStats(docs.length, result))) log(line)
  if (args.dryRun) {
    log("dry-run: không embed, không ghi DB")
    return 0
  }
  if (!embeddingAvailable()) {
    log("✖ Embedding chưa bật (EMBEDDING_PROVIDER=off hoặc thiếu GEMINI_API_KEY) — không ingest. Bật EMBEDDING_PROVIDER=gemini rồi chạy lại.")
    return 1
  }
  // Nạp muộn: dry-run không được kéo model Mongo / kết nối vào
  const { ingestChunks } = await import("../modules/knowledge/ingest.js")
  const connected = mongoose.connection.readyState === 1
  if (!connected) await mongoose.connect(env.MONGO_URI)
  try {
    log(`model embedding: ${embeddingModelId()}`)
    log(formatIngestSummary(await ingestChunks(result.chunks, { corpus: args.corpus })))
  } finally {
    if (!connected) await mongoose.disconnect()
  }
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runIngest(parseIngestArgs(process.argv.slice(2)))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error(err)
      process.exit(1)
    })
}
