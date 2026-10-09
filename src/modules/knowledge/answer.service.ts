/**
 * Trả lời có căn cứ (FLF-267): truy hồi → (không đủ căn cứ ⇒ câu cố định, KHÔNG gọi model, không trừ credit) → gắn nhãn
 * chunk K1..Kn vào prompt `knowledge-answer` → hậu kiểm trích dẫn bằng code:
 *   - bỏ nhãn không có trong tập đã truy hồi, bỏ ý không còn nhãn hợp lệ nào;
 *   - `grounded = false` hoặc không còn ý nào ⇒ câu "không đủ căn cứ" (theo ngôn ngữ trả lời);
 *   - `citations` chỉ gồm nhãn thật sự được trích, theo thứ tự xuất hiện.
 * Skill nội bộ luôn được gắn nhãn "FlintFlow internal guideline" trong prompt — model không được gọi nó là chuẩn ngoài.
 */

import { executeAiAction } from "../../shared/ai/ai-action.service.js"
import { ActionType, type AiActionInput } from "../../shared/ai/ai-action.types.js"
import type { KnowledgeAnswerOutput } from "../../shared/ai/response-parser.js"
import { byLanguage, type ReplyLanguage } from "../../shared/i18n/reply-language.js"
import type { KnowledgeSourceKind } from "./chunker.js"
import { retrieveKnowledge, type RetrievalBackend, type RetrievalResult, type RetrievedChunk, type RetrieveOptions } from "./retrieve.js"

/** Chat gửi `knowledge: true` khi `KNOWLEDGE_ENABLED` tắt (409). */
export const KNOWLEDGE_DISABLED = "KNOWLEDGE_DISABLED"

/** Corpus chat tra cứu (phase 1: skill nội bộ). */
export const DEFAULT_KNOWLEDGE_CORPUS = "skills"

/** Câu từ chối cố định — phân biệt được với câu lỗi hệ thống (test + tin lưu trong phiên có `grounded: false`). */
export const ABSTAIN_REPLY: Readonly<Record<ReplyLanguage, string>> = {
  vi: "Không đủ căn cứ trong kho tri thức của FlintFlow để trả lời câu này. Bạn thử hỏi cụ thể hơn, hoặc nêu bước / phần tài liệu đang làm nhé.",
  en: "There is not enough grounding in FlintFlow's knowledge base to answer this. Try a more specific question, or mention the step or document part you are working on."
}

const SOURCE_KIND_LABEL: Readonly<Record<KnowledgeSourceKind, string>> = {
  internal_skill: "FlintFlow internal guideline",
  standard: "external standard"
}

export interface KnowledgeClaim {
  text: string
  refs: string[]
}

export interface KnowledgeCitation {
  ref: string
  chunk_id: string
  source: string
  section: string
  source_kind: KnowledgeSourceKind
}

export type AbstainReason = "low_score" | "model_ungrounded" | "no_valid_claims"

export interface KnowledgeAnswer {
  grounded: boolean
  answer: string
  claims: KnowledgeClaim[]
  citations: KnowledgeCitation[]
  abstain_reason: AbstainReason | null
  retrieval: { backend: RetrievalBackend; top_vector_score: number | null; chunk_ids: string[] }
  /** Credit đã trừ (0 khi từ chối trước khi gọi model). */
  cost: number
  tokensUsed: { promptTokens: number; completionTokens: number; totalTokens: number } | null
}

// ─── hàm thuần ────────────────────────────────────────────────────

/** Nhãn `K<n>` (1-based) cho từng chunk theo thứ tự truy hồi. */
export const labelChunks = (chunks: readonly RetrievedChunk[]): Map<string, RetrievedChunk> => new Map(chunks.map((c, i) => [`K${i + 1}`, c]))

/** Khối chunk đưa vào prompt: `[K1] source: … · section: … · kind: …` rồi chữ (đã mở rộng small-to-big). */
export const formatChunksForPrompt = (labelled: ReadonlyMap<string, RetrievedChunk>): string =>
  [...labelled]
    .map(([label, c]) => `[${label}] source: ${c.source} · section: ${c.section} · kind: ${c.source_kind} (${SOURCE_KIND_LABEL[c.source_kind]})\n${c.context_text}`)
    .join("\n\n---\n\n")

/** `"[k2]"`, `" K2 "` ⇒ `K2`; chữ khác giữ nguyên để bị loại ở bước sau. */
const normalizeRef = (ref: string): string => ref.trim().replace(/^\[|\]$/g, "").trim().toUpperCase()

export interface PostCheckResult {
  grounded: boolean
  answer: string
  claims: KnowledgeClaim[]
  citations: KnowledgeCitation[]
  abstain_reason: AbstainReason | null
}

/** Hậu kiểm trích dẫn của model trên tập nhãn đã gửi. */
export const postCheckAnswer = (output: KnowledgeAnswerOutput, labelled: ReadonlyMap<string, RetrievedChunk>, language: ReplyLanguage): PostCheckResult => {
  const claims: KnowledgeClaim[] = output.claims.flatMap((claim) => {
    const refs = [...new Set(claim.refs.map(normalizeRef).filter((r) => labelled.has(r)))]
    return refs.length && claim.text.trim() ? [{ text: claim.text.trim(), refs }] : []
  })
  const abstainReason: AbstainReason | null = !output.grounded ? "model_ungrounded" : claims.length === 0 ? "no_valid_claims" : null
  if (abstainReason) return { grounded: false, answer: byLanguage(language, ABSTAIN_REPLY), claims: [], citations: [], abstain_reason: abstainReason }

  const cited: string[] = []
  for (const c of claims) for (const r of c.refs) if (!cited.includes(r)) cited.push(r)
  const citations = cited.map((ref) => {
    const c = labelled.get(ref)!
    return { ref, chunk_id: c.chunk_id, source: c.source, section: c.section, source_kind: c.source_kind }
  })
  // Nhãn lạ model viết trong câu trả lời (`[K9]`) bị gỡ — chỉ còn nhãn có trong `citations`
  const answer = output.answer
    .replace(/\s*\[(K\d+)\]/gi, (m, ref: string) => (cited.includes(ref.toUpperCase()) ? m : ""))
    .trim()
  return { grounded: true, answer: answer || claims.map((c) => c.text).join(" "), claims, citations, abstain_reason: null }
}

// ─── luồng ────────────────────────────────────────────────────────

/** Lượt gọi model của KNOWLEDGE_ANSWER — mặc định `executeAiAction` (giữ / trừ credit); eval thay bằng lượt gọi thẳng provider. */
export type KnowledgeInvoke = (input: AiActionInput) => Promise<{
  data: KnowledgeAnswerOutput
  cost?: number
  tokensUsed?: { promptTokens: number; completionTokens: number; totalTokens: number }
}>

const abstained = (retrieval: RetrievalResult, language: ReplyLanguage, reason: AbstainReason): KnowledgeAnswer => ({
  grounded: false,
  answer: byLanguage(language, ABSTAIN_REPLY),
  claims: [],
  citations: [],
  abstain_reason: reason,
  retrieval: { backend: retrieval.backend, top_vector_score: retrieval.top_vector_score, chunk_ids: retrieval.chunks.map((c) => c.chunk_id) },
  cost: 0,
  tokensUsed: null
})

/** Phần sau truy hồi — tách riêng để eval dùng cùng logic với chỉ mục trong process. */
export const answerFromRetrieval = async (question: string, retrieval: RetrievalResult, language: ReplyLanguage, invoke: KnowledgeInvoke): Promise<KnowledgeAnswer> => {
  // Chunk placeholder không bao giờ vào prompt, kể cả khi người gọi truy hồi với `includePlaceholder`. Hai phần cùng
  // section đã mở rộng small-to-big ra cùng một chữ ⇒ giữ một
  const seen = new Set<string>()
  const usable = retrieval.chunks.filter((c) => c.status === "verified" && !seen.has(c.context_text) && seen.add(c.context_text))
  if (retrieval.abstain || usable.length === 0) return abstained(retrieval, language, "low_score")
  const labelled = labelChunks(usable)
  // Thứ tự biến có nghĩa: `question` thay trước — chữ của chunk (có `{{…}}` của skill) không bị thay tiếp
  const result = await invoke({ promptVariables: { question, chunks: formatChunksForPrompt(labelled) }, replyLanguage: language })
  const checked = postCheckAnswer(result.data, labelled, language)
  return {
    ...checked,
    retrieval: { backend: retrieval.backend, top_vector_score: retrieval.top_vector_score, chunk_ids: usable.map((c) => c.chunk_id) },
    cost: result.cost ?? 0,
    tokensUsed: result.tokensUsed ?? null
  }
}

export interface AnswerContext {
  projectId: string | undefined
  userId: string
  language: ReplyLanguage
  corpus?: string | readonly string[]
  appliesTo?: RetrieveOptions["appliesTo"]
}

export const answerKnowledgeQuestion = async (question: string, ctx: AnswerContext): Promise<KnowledgeAnswer> => {
  const retrieval = await retrieveKnowledge(question, {
    corpus: ctx.corpus ?? DEFAULT_KNOWLEDGE_CORPUS,
    ...(ctx.appliesTo !== undefined ? { appliesTo: ctx.appliesTo } : {})
  })
  return answerFromRetrieval(question, retrieval, ctx.language, async (input) => {
    const res = await executeAiAction<KnowledgeAnswerOutput>(ActionType.KNOWLEDGE_ANSWER, input, ctx.projectId, ctx.userId)
    return { data: res.data, cost: res.cost, tokensUsed: res.tokensUsed }
  })
}
