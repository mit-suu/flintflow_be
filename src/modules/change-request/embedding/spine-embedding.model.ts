/**
 * Index embedding của phần tử Spine (collection `spine_embeddings`) cho C-3 tìm vị trí theo nghĩa. Dữ liệu **suy diễn**,
 * dựng lại được từ Spine bất kỳ lúc nào (`embedding-sync.service.ts`) — không phải nguồn sự thật, không đi qua op engine.
 * Atlas Vector Search index `spine_embeddings_vector`: vector `embedding` (768 chiều, cosine), lọc theo `projectId`,
 * `kind`, `entity`, `spine_version` — tạo bằng `src/scripts/migrate-spine-embeddings.ts`.
 */

import mongoose, { Schema, Document } from "mongoose"

export const SPINE_EMBEDDING_COLLECTION = "spine_embeddings"
export const SPINE_EMBEDDING_INDEX = "spine_embeddings_vector"
/** `element` = phần tử Spine (đơn vị vị trí CR). `block` để dành cho block của mục riêng, hiện chưa embed. */
export const SPINE_EMBEDDING_KINDS = ["element", "block"] as const
export type SpineEmbeddingKind = (typeof SPINE_EMBEDDING_KINDS)[number]

export interface ISpineEmbedding extends Document {
  projectId: mongoose.Types.ObjectId
  kind: SpineEmbeddingKind
  /** Path phần tử (`use_cases[id=UC-05]`, `project`) hoặc block_id. */
  ref: string
  /** Mảng Spine của phần tử (`use_cases`, `project`…). */
  entity: string
  section_id: string
  /** `spine_version` lúc đồng bộ gần nhất (dòng không đổi text cũng được nâng). */
  spine_version: number
  text: string
  /** sha256(model + text) — đổi text hoặc đổi model ⇒ embed lại. */
  text_hash: string
  embedding: number[]
}

const spineEmbeddingSchema = new Schema<ISpineEmbedding>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    kind: { type: String, enum: SPINE_EMBEDDING_KINDS, required: true },
    ref: { type: String, required: true },
    entity: { type: String, required: true },
    section_id: { type: String, required: true },
    spine_version: { type: Number, required: true },
    text: { type: String, required: true },
    text_hash: { type: String, required: true },
    embedding: { type: [Number], required: true }
  },
  { timestamps: true, collection: SPINE_EMBEDDING_COLLECTION }
)

spineEmbeddingSchema.index({ projectId: 1, kind: 1, ref: 1 }, { unique: true })

export const SpineEmbedding = mongoose.model<ISpineEmbedding>("SpineEmbedding", spineEmbeddingSchema)
