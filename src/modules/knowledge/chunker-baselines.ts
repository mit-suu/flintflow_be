/**
 * CHỈ DÙNG CHO EVAL (ablation của `eval-knowledge.ts`) — không ingest, không dùng ở production.
 *
 * Hai chunker đối chứng cho chunker chính (`chunker.ts`, section + header ngữ cảnh):
 *   - `fixedSizeChunks`: cửa sổ trượt cố định trên thân tài liệu (mặc định 512 token, chồng 64), không biết heading;
 *   - `headingChunksNoHeader`: đúng các chunk của chunker chính nhưng embed **không** kèm header ngữ cảnh.
 * Mọi chunk mang `span` trên cùng chuỗi `body` với chunker chính ⇒ eval so trùng khớp theo khoảng ký tự.
 */

import { CHARS_PER_TOKEN, chunkDocument, estimateTokens, type KnowledgeChunkDraft, type KnowledgeDoc } from "./chunker.js"

export const FIXED_CHUNK_TOKENS = 512
export const FIXED_OVERLAP_TOKENS = 64
/** Lùi điểm cắt tối đa chừng này ký tự để rơi vào khoảng trắng / xuống dòng, đỡ cắt giữa từ. */
const SNAP_CHARS = 120

/** Cửa sổ cố định `size` token, chồng `overlap` token (quy ra ký tự bằng `CHARS_PER_TOKEN`). */
export const fixedSizeChunks = (doc: KnowledgeDoc, size = FIXED_CHUNK_TOKENS, overlap = FIXED_OVERLAP_TOKENS): KnowledgeChunkDraft[] => {
  if (overlap >= size) throw new Error("overlap phải nhỏ hơn size")
  const body = doc.body
  const width = Math.floor(size * CHARS_PER_TOKEN)
  const back = Math.floor(overlap * CHARS_PER_TOKEN)
  const out: KnowledgeChunkDraft[] = []
  let start = 0
  // Bỏ khoảng trắng đầu thân
  while (start < body.length && /\s/.test(body[start]!)) start++
  for (let n = 1; start < body.length; n++) {
    let end = Math.min(body.length, start + width)
    if (end < body.length) {
      const nl = body.lastIndexOf("\n", end)
      const sp = body.lastIndexOf(" ", end)
      const snap = Math.max(nl, sp)
      if (snap > start && end - snap <= SNAP_CHARS) end = snap
    }
    const text = body.slice(start, end).trim()
    if (text) {
      const id = `${doc.doc_id}#fixed-${n}`
      out.push({
        chunk_id: id,
        corpus: doc.corpus,
        source: doc.source,
        source_kind: doc.source_kind,
        section: `fixed ${n}`,
        heading_path: [],
        parent_id: id,
        part: 0,
        applies_to: [...doc.applies_to],
        topic: doc.topic,
        status: doc.status,
        text,
        embed_text: text,
        tokens: estimateTokens(text),
        span: [start, end],
        merged: false,
        split: false
      })
    }
    if (end >= body.length) break
    start = Math.max(start + 1, end - back)
  }
  return out
}

/** Cùng chunk với chunker chính, `embed_text` = `text` (không header ngữ cảnh). */
export const headingChunksNoHeader = (doc: KnowledgeDoc): KnowledgeChunkDraft[] =>
  chunkDocument(doc).chunks.map((c) => ({ ...c, embed_text: c.text }))
