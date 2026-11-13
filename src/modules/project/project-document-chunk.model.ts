/**
 * Đơn vị truy xuất của tài liệu upload (FLF-393): mỗi tài liệu được cắt thành chunk theo cây section
 * (`shared/ai/document-retrieval/chunker.ts`), lưu một lần để lượt chat / Draft không phải nạp và cắt lại toàn văn.
 *
 * Chunk là dữ liệu **dựng lại được** từ `ProjectDocument.extractedText` + `outline`: thiếu hoặc lệch `chunker_version`
 * ⇒ `chunk-index.service.ts` dựng bù. `p_start` / `p_end` là chỉ số đoạn của `splitParagraphs` (mã `D<n>-P<m>`).
 */

import mongoose, { Schema, Document } from "mongoose"

export interface IProjectDocumentChunk extends Document {
  projectId: mongoose.Types.ObjectId
  documentId: mongoose.Types.ObjectId
  chunker_version: number
  /** Thứ tự chunk trong tài liệu (0-based). */
  ordinal: number
  heading_path: string[]
  titles: string[]
  p_start: number
  p_end: number
  paragraphs: string[]
  tokens: number
}

const projectDocumentChunkSchema = new Schema<IProjectDocumentChunk>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true, index: true },
    documentId: { type: Schema.Types.ObjectId, ref: "ProjectDocument", required: true },
    chunker_version: { type: Number, required: true },
    ordinal: { type: Number, required: true, min: 0 },
    heading_path: { type: [String], default: [] },
    titles: { type: [String], default: [] },
    p_start: { type: Number, required: true, min: 0 },
    p_end: { type: Number, required: true, min: 0 },
    paragraphs: { type: [String], default: [] },
    tokens: { type: Number, required: true, min: 0 }
  },
  { timestamps: false }
)

projectDocumentChunkSchema.index({ documentId: 1, ordinal: 1 }, { unique: true })

export const ProjectDocumentChunk = mongoose.model<IProjectDocumentChunk>("ProjectDocumentChunk", projectDocumentChunkSchema)
