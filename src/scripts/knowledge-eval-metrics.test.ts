import fs from "node:fs"
import { describe, it, expect } from "vitest"
import { chunkCorpus } from "../modules/knowledge/chunker.js"
import { loadCorpus } from "../modules/knowledge/corpus.js"
import {
  aggregateAnswers,
  evalQuestionSetSchema,
  firstHitRank,
  isHit,
  overlapRatio,
  retrievalMetrics,
  sweepAbstention,
  type AnswerRecord
} from "./knowledge-eval-metrics.js"
import { DEFAULT_QUESTIONS_FILE } from "./eval-knowledge.js"

describe("trùng khớp theo khoảng chữ", () => {
  const gold = { chunk_id: "doc#rules", span: [100, 200] as const }

  it("tỉ lệ chữ của chunk vàng nằm trong chunk truy hồi; khác tài liệu ⇒ 0", () => {
    expect(overlapRatio(gold, { chunk_id: "doc#fixed-1", span: [0, 150] })).toBe(0.5)
    expect(overlapRatio(gold, { chunk_id: "doc#fixed-2", span: [180, 400] })).toBeCloseTo(0.2)
    expect(overlapRatio(gold, { chunk_id: "other#fixed-1", span: [0, 1000] })).toBe(0)
  })

  it("trúng khi chứa ≥ 50% chunk vàng; hạng của chunk trúng đầu tiên", () => {
    expect(isHit(gold, { chunk_id: "doc#fixed-1", span: [0, 150] })).toBe(true)
    expect(isHit(gold, { chunk_id: "doc#fixed-2", span: [160, 400] })).toBe(false)
    const ranked = [
      { chunk_id: "x#a", span: [0, 10] as const },
      { chunk_id: "doc#rules", span: [100, 200] as const }
    ]
    expect(firstHitRank(ranked, [gold])).toBe(2)
    expect(firstHitRank(ranked.slice(0, 1), [gold])).toBeNull()
  })

  it("recall@k và MRR@10", () => {
    const m = retrievalMetrics([1, 3, null, 12])
    expect(m).toEqual({ n: 4, recall_at_1: 0.25, recall_at_3: 0.5, recall_at_5: 0.5, mrr_at_10: (1 + 1 / 3) / 4 })
  })
})

describe("quét ngưỡng từ chối", () => {
  it("F1 với lớp dương = ngoài corpus; bằng F1 ⇒ ngưỡng thấp hơn", () => {
    const items = [
      { top: 0.9, ooc: false },
      { top: 0.7, ooc: false },
      { top: 0.5, ooc: true },
      { top: null, ooc: true }
    ]
    const { rows, best } = sweepAbstention(items)
    expect(rows).toHaveLength(46)
    expect(rows[0]!.threshold).toBe(0.4)
    expect(rows[rows.length - 1]!.threshold).toBe(0.85)
    expect(best).toMatchObject({ threshold: 0.51, f1: 1, in_corpus_answered: 1, out_of_corpus_abstained: 1 })
  })
})

describe("tổng hợp câu trả lời", () => {
  const rec = (over: Partial<AnswerRecord>): AnswerRecord => ({
    id: "q",
    mode: "rag",
    out_of_corpus: false,
    abstained: false,
    correct: 1,
    faithful: true,
    refs_total: 2,
    refs_valid: 2,
    error: null,
    ...over
  })

  it("đúng (từ chối = 0), trung thực, ảo giác ngoài corpus, nhãn hợp lệ, lỗi", () => {
    const agg = aggregateAnswers([
      rec({ correct: 1 }),
      rec({ abstained: true, correct: 1, faithful: null, refs_total: 0, refs_valid: 0 }),
      rec({ correct: 0.5, faithful: false, refs_total: 2, refs_valid: 1 }),
      rec({ out_of_corpus: true, abstained: false, correct: 0, faithful: false }),
      rec({ out_of_corpus: true, abstained: true, correct: 1, faithful: null, refs_total: 0, refs_valid: 0 }),
      rec({ error: "boom" })
    ])
    expect(agg).toMatchObject({ n: 6, in_corpus: 3, out_of_corpus: 2, errors: 1 })
    expect(agg.correctness).toBeCloseTo(0.5)
    expect(agg.in_corpus_answered).toBeCloseTo(2 / 3)
    expect(agg.faithfulness).toBeCloseTo(1 / 3)
    expect(agg.out_of_corpus_hallucination).toBe(0.5)
    expect(agg.citation_validity).toBeCloseTo(5 / 6)
  })
})

describe("bộ câu hỏi fixtures/knowledge-eval/questions.json", () => {
  const set = evalQuestionSetSchema.parse(JSON.parse(fs.readFileSync(DEFAULT_QUESTIONS_FILE, "utf-8")))

  it("40 câu: 32 trong corpus (đủ 5 loại), 8 ngoài corpus; id không trùng", () => {
    const by = (t: string) => set.questions.filter((q) => q.type === t).length
    expect(set.questions).toHaveLength(40)
    expect(set.questions.filter((q) => q.out_of_corpus)).toHaveLength(8)
    expect({ exact: by("exact"), paraphrase: by("paraphrase"), cross_lingual: by("cross_lingual"), table_list: by("table_list"), generic_heading: by("generic_heading") }).toEqual({
      exact: 8,
      paraphrase: 7,
      cross_lingual: 7,
      table_list: 5,
      generic_heading: 5
    })
    expect(new Set(set.questions.map((q) => q.id)).size).toBe(40)
    expect(set.questions.filter((q) => q.type === "cross_lingual").every((q) => q.language === "vi")).toBe(true)
  })

  // Đổi skill / chunker làm id đổi thì test này đỏ — eval không được lặng lẽ chấm trên id đã mất
  it("mọi gold_chunk_id còn tồn tại trong cách chunk hiện tại của corpus", () => {
    const ids = new Set(chunkCorpus(loadCorpus("assets/skills", { corpus: set.corpus })).chunks.map((c) => c.chunk_id))
    const missing = set.questions.flatMap((q) => q.gold_chunk_ids.filter((g) => !ids.has(g)).map((g) => `${q.id}: ${g}`))
    expect(missing).toEqual([])
  })

  it("câu generic_heading hỏi về section Rules của các skill khác nhau", () => {
    const golds = set.questions.filter((q) => q.type === "generic_heading").flatMap((q) => q.gold_chunk_ids)
    expect(golds.every((g) => g.endsWith("#rules"))).toBe(true)
    expect(new Set(golds.map((g) => g.split("#")[0])).size).toBe(golds.length)
  })
})
