/**
 * Chấm điểm cho `eval-knowledge.ts` (FLF-267) — hàm thuần, không gọi provider.
 *
 * **Trùng khớp khi chunker khác id vàng.** `gold_chunk_ids` lấy theo chunker chính; chunker đối chứng (fixed-size) có id
 * khác. Mọi chunk mang `span` = khoảng ký tự [start, end) trên CÙNG thân tài liệu (`KnowledgeDoc.body`), nên:
 *   chunk truy hồi R **trúng** chunk vàng G ⇔ cùng tài liệu (tiền tố id trước `#`) và
 *   |R ∩ G| ≥ `GOLD_OVERLAP_MIN` × |G| (R chứa ít nhất một nửa chữ của G).
 * Luật này áp cho cả 9 ô của ablation (với chunker chính, trùng id ⇒ trùng 100%), nên các ô so được với nhau.
 * Câu có 2 chunk vàng: trúng một trong hai là trúng (recall theo câu hỏi, không theo chunk).
 */

import { z } from "zod"

export const GOLD_OVERLAP_MIN = 0.5
export const QUESTION_TYPES = ["exact", "paraphrase", "cross_lingual", "table_list", "generic_heading", "out_of_corpus"] as const

export const evalQuestionSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(QUESTION_TYPES),
    language: z.enum(["vi", "en"]),
    question: z.string().min(1),
    answer_points: z.array(z.string().min(1)).max(4).default([]),
    gold_chunk_ids: z.array(z.string().min(1)).max(2).default([]),
    out_of_corpus: z.boolean().default(false),
    note: z.string().optional()
  })
  .refine((q) => q.out_of_corpus === (q.type === "out_of_corpus"), { message: "out_of_corpus phải khớp type" })
  .refine((q) => q.out_of_corpus || (q.gold_chunk_ids.length >= 1 && q.answer_points.length >= 2), {
    message: "câu trong corpus cần 1–2 gold_chunk_ids và 2–4 answer_points"
  })

export const evalQuestionSetSchema = z.object({
  corpus: z.string().min(1),
  questions: z.array(evalQuestionSchema).min(1)
})

export type EvalQuestion = z.infer<typeof evalQuestionSchema>
export type EvalQuestionSet = z.infer<typeof evalQuestionSetSchema>

// ─── trùng khớp + chỉ số truy hồi ─────────────────────────────────

export interface SpanRef {
  chunk_id: string
  span: readonly [number, number]
}

export const docOf = (chunkId: string): string => chunkId.split("#")[0]!

/** Tỉ lệ chữ của `gold` nằm trong `got` (0..1); khác tài liệu ⇒ 0. */
export const overlapRatio = (gold: SpanRef, got: SpanRef): number => {
  if (docOf(gold.chunk_id) !== docOf(got.chunk_id)) return 0
  const len = gold.span[1] - gold.span[0]
  if (len <= 0) return 0
  const inter = Math.min(gold.span[1], got.span[1]) - Math.max(gold.span[0], got.span[0])
  return Math.max(0, inter) / len
}

export const isHit = (gold: SpanRef, got: SpanRef): boolean => overlapRatio(gold, got) >= GOLD_OVERLAP_MIN

/** Hạng (1-based) của chunk đầu tiên trúng một chunk vàng; không trúng ⇒ null. */
export const firstHitRank = (ranked: readonly SpanRef[], golds: readonly SpanRef[]): number | null => {
  const idx = ranked.findIndex((r) => golds.some((g) => isHit(g, r)))
  return idx < 0 ? null : idx + 1
}

export interface RetrievalMetrics {
  n: number
  recall_at_1: number
  recall_at_3: number
  recall_at_5: number
  /** MRR trên top 10 (không trúng trong top 10 ⇒ 0). */
  mrr_at_10: number
}

export const retrievalMetrics = (ranks: readonly (number | null)[]): RetrievalMetrics => {
  const n = ranks.length
  const within = (k: number): number => (n ? ranks.filter((r) => r !== null && r <= k).length / n : 0)
  return {
    n,
    recall_at_1: within(1),
    recall_at_3: within(3),
    recall_at_5: within(5),
    mrr_at_10: n ? ranks.reduce<number>((s, r) => s + (r !== null && r <= 10 ? 1 / r : 0), 0) / n : 0
  }
}

// ─── ngưỡng từ chối ───────────────────────────────────────────────

export interface AbstentionRow {
  threshold: number
  precision: number
  recall: number
  f1: number
  /** Tỉ lệ câu trong corpus vẫn được trả lời (không bị từ chối nhầm). */
  in_corpus_answered: number
  /** Tỉ lệ câu ngoài corpus bị từ chối (đúng). */
  out_of_corpus_abstained: number
}

/**
 * Quét ngưỡng cosine: từ chối ⇔ top cosine < ngưỡng (không có vector ⇒ từ chối). Lớp dương = câu ngoài corpus.
 * Ngưỡng tốt nhất: F1 cao nhất, bằng nhau ⇒ ngưỡng thấp hơn (ít từ chối nhầm câu trong corpus hơn).
 */
export const sweepAbstention = (
  items: readonly { top: number | null; ooc: boolean }[],
  from = 0.4,
  to = 0.85,
  step = 0.01
): { rows: AbstentionRow[]; best: AbstentionRow | null } => {
  const rows: AbstentionRow[] = []
  const inCorpus = items.filter((i) => !i.ooc).length
  const ooc = items.filter((i) => i.ooc).length
  const steps = Math.round((to - from) / step)
  for (let s = 0; s <= steps; s++) {
    const threshold = Math.round((from + s * step) * 100) / 100
    const abstain = (top: number | null): boolean => top === null || top < threshold
    const tp = items.filter((i) => i.ooc && abstain(i.top)).length
    const fp = items.filter((i) => !i.ooc && abstain(i.top)).length
    const fn = ooc - tp
    const precision = tp + fp ? tp / (tp + fp) : 0
    const recall = tp + fn ? tp / (tp + fn) : 0
    rows.push({
      threshold,
      precision,
      recall,
      f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0,
      in_corpus_answered: inCorpus ? (inCorpus - fp) / inCorpus : 0,
      out_of_corpus_abstained: ooc ? tp / ooc : 0
    })
  }
  const best = rows.reduce<AbstentionRow | null>((b, r) => (!b || r.f1 > b.f1 ? r : b), null)
  return { rows, best }
}

// ─── câu trả lời ──────────────────────────────────────────────────

/** Đầu ra của judge (`fixtures/knowledge-eval/judge.md`). */
export const judgeOutputSchema = z.object({
  correct: z.number().min(0).max(1),
  faithful: z.boolean().nullable().default(null),
  abstained: z.boolean(),
  notes: z.string().optional()
})
export type JudgeOutput = z.infer<typeof judgeOutputSchema>

export interface AnswerRecord {
  id: string
  mode: "rag" | "norag"
  out_of_corpus: boolean
  /** RAG: từ chối theo code (`grounded = false`); no-RAG: theo judge. */
  abstained: boolean
  /** 0..1 theo judge; từ chối ⇒ 0. `null` khi judge lỗi. */
  correct: number | null
  /** RAG đã trả lời: mọi ý được chunk nó trích đỡ không (judge). */
  faithful: boolean | null
  /** Nhãn model trả trước hậu kiểm / số nhãn hợp lệ (RAG). */
  refs_total: number
  refs_valid: number
  error: string | null
}

export interface AnswerAggregate {
  n: number
  in_corpus: number
  out_of_corpus: number
  /** Trung bình `correct` trên câu trong corpus (từ chối = 0, judge lỗi bị bỏ). */
  correctness: number
  /** Tỉ lệ câu trong corpus được trả lời. */
  in_corpus_answered: number
  /** Tỉ lệ câu RAG đã trả lời mà judge chấm trung thực. */
  faithfulness: number | null
  /** Câu ngoài corpus bị trả lời thay vì từ chối (ảo giác). */
  out_of_corpus_hallucination: number
  /** Nhãn hợp lệ / tổng nhãn model trả (RAG). */
  citation_validity: number | null
  errors: number
}

const mean = (xs: readonly number[]): number => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0)

export const aggregateAnswers = (records: readonly AnswerRecord[]): AnswerAggregate => {
  const ok = records.filter((r) => !r.error)
  const inCorpus = ok.filter((r) => !r.out_of_corpus)
  const ooc = ok.filter((r) => r.out_of_corpus)
  const answered = ok.filter((r) => !r.abstained)
  const faithfulJudged = answered.filter((r) => r.faithful !== null)
  const refsTotal = ok.reduce((s, r) => s + r.refs_total, 0)
  return {
    n: records.length,
    in_corpus: inCorpus.length,
    out_of_corpus: ooc.length,
    correctness: mean(inCorpus.filter((r) => r.abstained || r.correct !== null).map((r) => (r.abstained ? 0 : r.correct!))),
    in_corpus_answered: inCorpus.length ? inCorpus.filter((r) => !r.abstained).length / inCorpus.length : 0,
    faithfulness: faithfulJudged.length ? faithfulJudged.filter((r) => r.faithful).length / faithfulJudged.length : null,
    out_of_corpus_hallucination: ooc.length ? ooc.filter((r) => !r.abstained).length / ooc.length : 0,
    citation_validity: refsTotal ? ok.reduce((s, r) => s + r.refs_valid, 0) / refsTotal : null,
    errors: records.length - ok.length
  }
}
