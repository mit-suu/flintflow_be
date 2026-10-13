/**
 * Chunk tri thức đã ingest (FLF-267), collection `knowledge_chunks`. Một dòng = một chunk của `chunker.ts` + vector.
 *
 * - `text` hiển thị / đưa vào prompt; `embed_text` = header ngữ cảnh + `text`, là thứ được embed và được index `$text`.
 * - `text_hash` = sha256(model id + `embed_text`): ingest chỉ embed lại dòng đổi hash (đổi chữ hoặc đổi model).
 * - Atlas Vector Search index `knowledge_chunks_vector` KHÔNG do mongoose tạo — `npm run migrate:knowledge-index`.
 * - Text index: `section` nặng hơn `embed_text` (heading nói đúng chủ đề hơn thân bài).
 */

import mongoose, { Schema } from "mongoose"
import type { KnowledgeSourceKind, KnowledgeStatus } from "./chunker.js"

export const KNOWLEDGE_CHUNK_COLLECTION = "knowledge_chunks"
export const KNOWLEDGE_VECTOR_INDEX = "knowledge_chunks_vector"
/** Tên text index — script migrate đối chiếu theo tên này. */
export const KNOWLEDGE_TEXT_INDEX = "knowledge_chunks_text"
export const KNOWLEDGE_TEXT_INDEX_WEIGHTS = { section: 4, embed_text: 1 } as const

/** Không kế thừa `Document`: field `model` (theo thiết kế) trùng tên hàm `Document#model` — mọi truy vấn đều `lean()`. */
export interface IKnowledgeChunk {
  chunk_id: string
  corpus: string
  source: string
  source_kind: KnowledgeSourceKind
  section: string
  heading_path: string[]
  parent_id: string
  part: number
  applies_to: string[]
  topic: string
  status: KnowledgeStatus
  text: string
  embed_text: string
  tokens: number
  text_hash: string
  model: string
  embedding: number[]
  createdAt: Date
  updatedAt: Date
}

const knowledgeChunkSchema = new Schema<IKnowledgeChunk>(
  {
    chunk_id: { type: String, required: true, unique: true },
    corpus: { type: String, required: true },
    source: { type: String, required: true },
    source_kind: { type: String, enum: ["internal_skill", "standard"], required: true },
    section: { type: String, required: true },
    heading_path: { type: [String], default: [] },
    parent_id: { type: String, required: true },
    part: { type: Number, default: 0 },
    applies_to: { type: [String], default: [] },
    topic: { type: String, default: "" },
    status: { type: String, enum: ["placeholder", "verified"], required: true },
    text: { type: String, required: true },
    embed_text: { type: String, required: true },
    tokens: { type: Number, required: true },
    text_hash: { type: String, required: true },
    model: { type: String, required: true },
    embedding: { type: [Number], default: [] }
  },
  { timestamps: true, collection: KNOWLEDGE_CHUNK_COLLECTION }
)

knowledgeChunkSchema.index({ corpus: 1, status: 1 })
knowledgeChunkSchema.index({ parent_id: 1 })
// Corpus chủ yếu tiếng Anh ⇒ stemming/stopword tiếng Anh. Không có field `language` trong document nên không bị override.
knowledgeChunkSchema.index(
  { section: "text", embed_text: "text" },
  { name: KNOWLEDGE_TEXT_INDEX, weights: { ...KNOWLEDGE_TEXT_INDEX_WEIGHTS }, default_language: "english" }
)

export const KnowledgeChunk = mongoose.model<IKnowledgeChunk>("KnowledgeChunk", knowledgeChunkSchema)
