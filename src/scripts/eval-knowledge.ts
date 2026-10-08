/**
 * eval-knowledge.ts — đo Knowledge RAG (FLF-267) trên bộ câu hỏi `fixtures/knowledge-eval/questions.json`.
 * ─────────────────────────────────────────────────────────────────
 * Không nối Mongo: corpus đọc từ đĩa, chunk + embed trong process, tìm vector bằng cosine vét cạn (cùng hàm
 * `searchRows` của backend `memory`), tìm từ khoá bằng BM25 trong process (`modules/knowledge/bm25.ts` — production
 * dùng Mongo `$text`; ablation cần chấm cả chunker không lưu DB nên cả 9 ô dùng BM25 cho công bằng), gộp bằng đúng
 * `rrfFuse` / `shouldAbstain` / `expandToParent` của `retrieve.ts`.
 *
 * Hai chế độ:
 *   --retrieval-only   chỉ embedding (không LLM). Ablation chunker {fixed-512/64, heading-no-header, heading+header} ×
 *                      truy hồi {lexical, vector, hybrid}: recall@1/3/5, MRR@10 (trùng khớp theo khoảng chữ — xem
 *                      `knowledge-eval-metrics.ts`). Rồi quét ngưỡng từ chối 0,40–0,85 (bước 0,01) trên top cosine của
 *                      cấu hình cuối (heading+header, hybrid): F1 trong corpus vs ngoài corpus + ngưỡng chọn.
 *   --answers          RAG (`answerFromRetrieval` của answer.service, model của skill `knowledge-answer`) so với no-RAG
 *                      (cùng model, chỉ câu hỏi — `fixtures/knowledge-eval/norag.md`), chấm bằng LLM judge
 *                      (`fixtures/knowledge-eval/judge.md`): đúng (phủ answer_points), trung thực (RAG), từ chối; cộng
 *                      tỉ lệ trích dẫn hợp lệ đo bằng code. `--mode rag|norag|both` (mặc định both).
 * Lượt gọi model ở đây đi thẳng provider (`callLLM`), không qua `executeAiAction` ⇒ không giữ / trừ credit, không ghi log AI.
 *
 * Cách dùng (provider thật — xem docs/knowledge-rag.md):
 *   EMBEDDING_PROVIDER=gemini npm run eval:knowledge -- --retrieval-only --label baseline
 *   EMBEDDING_PROVIDER=gemini npm run eval:knowledge -- --answers --mode both --label baseline --min-score 0.62
 * Quota embedding (free tier 1 000 text/ngày): thêm `--cache` (cache vector ra file, lượt sau chỉ embed phần thiếu) và
 * `--seed-cache-from-db` (nạp vector đã ingest ở `knowledge_chunks` — cần MONGO_URI) — xem `eval-embedding-cache.ts`.
 * Cờ: --dir (mặc định KNOWLEDGE_CORPUS_DIR) · --questions FILE · --label TÊN · --limit N · --ids a,b · --min-score X
 *     · --top-k N · --judge-provider P · --judge-model M · --out DIR
 * Kết quả: `test/e2e-ai/results/knowledge-eval-<label>-<ISO>.{md,json}` (thư mục bị gitignore), in `.md` ra stdout.
 * Trước khi chạy in ước lượng số lượt gọi thật (embedding, LLM) và token.
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import matter from "gray-matter"
import { env } from "../config/env.js"
import { ActionType, type AiActionInput, type AiProviderConfig } from "../shared/ai/ai-action.types.js"
import { embeddingAvailable, embeddingModelId, embeddingProvider } from "../shared/ai/embedding/embedding.provider.js"
import { getPromptTemplate, interpolatePrompt } from "../shared/ai/prompt-registry.service.js"
import { callLLM } from "../shared/ai/providers/llm.router.js"
import { extractJsonFromText, parseResponse, type KnowledgeAnswerOutput } from "../shared/ai/response-parser.js"
import { replyLanguageDirective, type ReplyLanguage } from "../shared/i18n/reply-language.js"
import { answerFromRetrieval, labelChunks, type KnowledgeAnswer } from "../modules/knowledge/answer.service.js"
import { buildBm25, searchBm25, type Bm25Index } from "../modules/knowledge/bm25.js"
import { fixedSizeChunks, headingChunksNoHeader } from "../modules/knowledge/chunker-baselines.js"
import { chunkCorpus, estimateTokens, type KnowledgeChunkDraft, type KnowledgeDoc } from "../modules/knowledge/chunker.js"
import { loadCorpus } from "../modules/knowledge/corpus.js"
import { DEFAULT_CANDIDATES, expandToParent, rrfFuse, shouldAbstain, type FusedHit, type RetrievalMode, type RetrievalResult, type RetrievedChunk } from "../modules/knowledge/retrieve.js"
import { searchRows, type MemoryRow } from "../modules/knowledge/vector-backend.js"
import { createEmbeddingCache, type EmbeddingCache } from "./eval-embedding-cache.js"
import {
  aggregateAnswers,
  evalQuestionSetSchema,
  firstHitRank,
  judgeOutputSchema,
  retrievalMetrics,
  sweepAbstention,
  type AbstentionRow,
  type AnswerAggregate,
  type AnswerRecord,
  type EvalQuestion,
  type RetrievalMetrics,
  type SpanRef
} from "./knowledge-eval-metrics.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "../..")
export const DEFAULT_QUESTIONS_FILE = path.join(REPO_ROOT, "fixtures/knowledge-eval/questions.json")
export const DEFAULT_RESULTS_DIR = path.join(REPO_ROOT, "test/e2e-ai/results")
export const DEFAULT_EMBEDDING_CACHE = path.join(DEFAULT_RESULTS_DIR, ".knowledge-embedding-cache.jsonl")
const JUDGE_PROMPT_FILE = path.join(REPO_ROOT, "fixtures/knowledge-eval/judge.md")
const NORAG_PROMPT_FILE = path.join(REPO_ROOT, "fixtures/knowledge-eval/norag.md")

export const CHUNKERS = ["fixed-512/64", "heading-no-header", "heading+header"] as const
export type ChunkerName = (typeof CHUNKERS)[number]
export const RETRIEVAL_MODES: readonly RetrievalMode[] = ["lexical", "vector", "hybrid"]
/** Cấu hình cuối = cấu hình production. */
export const FINAL_CHUNKER: ChunkerName = "heading+header"
export const FINAL_MODE: RetrievalMode = "hybrid"
/** Token ra ước lượng của một câu trả lời / một lượt chấm — chỉ để in ước lượng chi phí. */
const EST_ANSWER_OUT = 300
const EST_JUDGE_OUT = 120

export interface EvalOptions {
  dir: string
  questionsFile: string
  label: string
  outDir: string
  retrievalOnly: boolean
  answers: boolean
  mode: "rag" | "norag" | "both"
  limit: number | null
  ids: string[] | null
  minScore: number
  topK: number
  judgeProvider: string | null
  judgeModel: string | null
  /** File cache vector (`--cache [FILE]`); null ⇒ chỉ trong bộ nhớ. */
  cacheFile: string | null
  seedCacheFromDb: boolean
  log: (line: string) => void
}

export const parseEvalArgs = (argv: readonly string[]): EvalOptions => {
  const o: EvalOptions = {
    dir: env.KNOWLEDGE_CORPUS_DIR,
    questionsFile: DEFAULT_QUESTIONS_FILE,
    label: "run",
    outDir: DEFAULT_RESULTS_DIR,
    retrievalOnly: false,
    answers: false,
    mode: "both",
    limit: null,
    ids: null,
    minScore: env.KNOWLEDGE_MIN_SCORE,
    topK: env.KNOWLEDGE_TOP_K,
    judgeProvider: null,
    judgeModel: null,
    cacheFile: null,
    seedCacheFromDb: false,
    log: (line) => process.stdout.write(`${line}\n`)
  }
  for (let i = 0; i < argv.length; i++) {
    const next = (): string => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`Thiếu giá trị cho ${argv[i - 1]}`)
      return v
    }
    switch (argv[i]) {
      case "--retrieval-only": o.retrievalOnly = true; break
      case "--answers": o.answers = true; break
      case "--mode": {
        const m = next()
        if (m !== "rag" && m !== "norag" && m !== "both") throw new Error(`--mode phải là rag | norag | both`)
        o.mode = m
        break
      }
      case "--dir": o.dir = next(); break
      case "--questions": o.questionsFile = next(); break
      case "--label": o.label = next(); break
      case "--out": o.outDir = next(); break
      case "--limit": o.limit = Number(next()); break
      case "--ids": o.ids = next().split(","); break
      case "--min-score": o.minScore = Number(next()); break
      case "--top-k": o.topK = Number(next()); break
      case "--judge-provider": o.judgeProvider = next(); break
      case "--judge-model": o.judgeModel = next(); break
      case "--cache": o.cacheFile = argv[i + 1] && !argv[i + 1]!.startsWith("--") ? next() : DEFAULT_EMBEDDING_CACHE; break
      case "--seed-cache-from-db": o.seedCacheFromDb = true; break
      default: throw new Error(`Cờ không nhận ra: ${argv[i]}`)
    }
  }
  if (o.retrievalOnly === o.answers) throw new Error("Chọn đúng một chế độ: --retrieval-only hoặc --answers")
  return o
}

// ─── cache embedding ──────────────────────────────────────────────

/** Vector đã ingest (cùng model) của corpus ⇒ cache, khoá theo `embed_text` + RETRIEVAL_DOCUMENT. Trả số khoá mới. */
const seedCacheFromDb = async (cache: EmbeddingCache, corpus: string): Promise<number> => {
  const mongoose = (await import("mongoose")).default
  const { KnowledgeChunk } = await import("../modules/knowledge/knowledge-chunk.model.js")
  await mongoose.connect(env.MONGO_URI, { autoIndex: false, autoCreate: false })
  try {
    const rows = await KnowledgeChunk.find({ corpus, model: embeddingModelId() }, { embed_text: 1, embedding: 1, _id: 0 }).lean()
    return cache.seed(rows.filter((r) => r.embedding?.length).map((r) => ({ text: r.embed_text, taskType: "RETRIEVAL_DOCUMENT" as const, vector: r.embedding })))
  } finally {
    await mongoose.disconnect()
  }
}

// ─── chỉ mục trong process ────────────────────────────────────────

interface InProcessIndex {
  name: ChunkerName
  chunks: KnowledgeChunkDraft[]
  byId: Map<string, KnowledgeChunkDraft>
  rows: MemoryRow[]
  bm25: Bm25Index
}

export const chunksFor = (name: ChunkerName, docs: readonly KnowledgeDoc[]): KnowledgeChunkDraft[] =>
  name === "fixed-512/64" ? docs.flatMap((d) => fixedSizeChunks(d)) : name === "heading-no-header" ? docs.flatMap((d) => headingChunksNoHeader(d)) : chunkCorpus(docs).chunks

const buildIndex = async (cache: EmbeddingCache, name: ChunkerName, chunks: KnowledgeChunkDraft[]): Promise<InProcessIndex> => {
  const vectors = await cache.embed(
    chunks.map((c) => c.embed_text),
    "RETRIEVAL_DOCUMENT"
  )
  return {
    name,
    chunks,
    byId: new Map(chunks.map((c) => [c.chunk_id, c])),
    rows: chunks.map((c, i) => ({ chunk_id: c.chunk_id, corpus: c.corpus, status: c.status, applies_to: c.applies_to, embedding: vectors[i]! })),
    // Như index `$text` của production: chữ được index là `embed_text`
    bm25: buildBm25(chunks.map((c) => ({ id: c.chunk_id, text: c.embed_text })))
  }
}

interface Ranked {
  fused: FusedHit[]
  topCosine: number | null
  lexicalHits: number
}

const rankIn = (index: InProcessIndex, queryVector: readonly number[], query: string, mode: RetrievalMode, candidates = DEFAULT_CANDIDATES): Ranked => {
  const corpus = [...new Set(index.chunks.map((c) => c.corpus))]
  const vector = mode === "lexical" ? [] : searchRows(index.rows, queryVector, { corpus, statuses: ["verified", "placeholder"] }, candidates)
  const lexical = mode === "vector" ? [] : searchBm25(index.bm25, query, candidates).map((h) => h.id)
  return { fused: rrfFuse(vector, lexical), topCosine: vector[0]?.cosine ?? null, lexicalHits: lexical.length }
}

/** Dựng `RetrievalResult` như `retrieveKnowledge` trả, từ chỉ mục trong process (backend `memory`). */
const retrievalResultFrom = (index: InProcessIndex, ranked: Ranked, topK: number, minScore: number): RetrievalResult => {
  const top = ranked.fused.slice(0, topK)
  const chunks: RetrievedChunk[] = top.map((f) => {
    const c = index.byId.get(f.chunk_id)!
    const siblings = index.chunks.filter((s) => s.parent_id === c.parent_id)
    return {
      chunk_id: c.chunk_id,
      source: c.source,
      source_kind: c.source_kind,
      section: c.section,
      status: c.status,
      text: c.text,
      context_text: expandToParent(c, siblings),
      ...(f.vector_score !== undefined ? { vector_score: f.vector_score } : {}),
      ...(f.vector_rank !== undefined ? { vector_rank: f.vector_rank } : {}),
      ...(f.lexical_rank !== undefined ? { lexical_rank: f.lexical_rank } : {}),
      rrf: f.rrf
    }
  })
  return {
    chunks,
    top_vector_score: ranked.topCosine,
    backend: "memory",
    abstain: shouldAbstain(ranked.topCosine, ranked.topCosine !== null, ranked.lexicalHits, minScore) || chunks.length === 0
  }
}

// ─── câu hỏi ──────────────────────────────────────────────────────

export const loadQuestions = (file: string, options: Pick<EvalOptions, "ids" | "limit">): { corpus: string; questions: EvalQuestion[] } => {
  const set = evalQuestionSetSchema.parse(JSON.parse(fs.readFileSync(file, "utf-8")))
  let questions = set.questions
  if (options.ids) questions = questions.filter((q) => options.ids!.includes(q.id))
  if (options.limit !== null && options.limit > 0) questions = questions.slice(0, options.limit)
  return { corpus: set.corpus, questions }
}

const goldSpans = (q: EvalQuestion, finalById: ReadonlyMap<string, KnowledgeChunkDraft>): SpanRef[] =>
  q.gold_chunk_ids.map((id) => {
    const c = finalById.get(id)
    if (!c) throw new Error(`Câu ${q.id}: gold_chunk_id "${id}" không còn trong cách chunk hiện tại — cập nhật questions.json`)
    return { chunk_id: c.chunk_id, span: c.span }
  })

// ─── ước lượng chi phí ────────────────────────────────────────────

export interface CostEstimate {
  embedding_calls: number
  embedding_texts: number
  embedding_tokens: number
  llm_calls: number
  llm_prompt_tokens: number
  llm_completion_tokens: number
}

const batches = (n: number): number => Math.ceil(n / 100)

export const estimateCost = (
  opts: Pick<EvalOptions, "retrievalOnly" | "mode" | "topK">,
  chunkSets: readonly KnowledgeChunkDraft[][],
  questions: readonly EvalQuestion[],
  templateTokens: { rag: number; norag: number; judge: number }
): CostEstimate => {
  const qTokens = questions.reduce((s, q) => s + estimateTokens(q.question), 0)
  const docTexts = chunkSets.reduce((s, c) => s + c.length, 0)
  const docTokens = chunkSets.reduce((s, cs) => s + cs.reduce((t, c) => t + estimateTokens(c.embed_text), 0), 0)
  const embedding = {
    embedding_calls: chunkSets.reduce((s, c) => s + batches(c.length), 0) + batches(questions.length),
    embedding_texts: docTexts + questions.length,
    embedding_tokens: docTokens + qTokens
  }
  if (opts.retrievalOnly) return { ...embedding, llm_calls: 0, llm_prompt_tokens: 0, llm_completion_tokens: 0 }
  const final = chunkSets[chunkSets.length - 1] ?? []
  const avgChunk = final.length ? final.reduce((s, c) => s + c.tokens, 0) / final.length : 0
  const n = questions.length
  const rag = opts.mode !== "norag" ? n : 0
  const norag = opts.mode !== "rag" ? n : 0
  const ragIn = rag * (templateTokens.rag + opts.topK * avgChunk) + qTokens * (rag ? 1 : 0)
  const noragIn = norag * templateTokens.norag + qTokens * (norag ? 1 : 0)
  // Judge RAG đọc thêm chữ chunk được trích (≈ top-K chunk)
  const judgeIn = (rag + norag) * (templateTokens.judge + EST_ANSWER_OUT) + rag * opts.topK * avgChunk
  return {
    ...embedding,
    llm_calls: 2 * (rag + norag),
    llm_prompt_tokens: Math.round(ragIn + noragIn + judgeIn),
    llm_completion_tokens: (rag + norag) * (EST_ANSWER_OUT + EST_JUDGE_OUT)
  }
}

const formatEstimate = (e: CostEstimate): string[] => [
  "Ước lượng lượt gọi thật (cận trên — câu bị từ chối không gọi LLM trả lời):",
  `  embedding: ${e.embedding_calls} lượt batchEmbedContents · ${e.embedding_texts} text · ~${e.embedding_tokens} token`,
  `  LLM: ${e.llm_calls} lượt (trả lời + judge) · ~${e.llm_prompt_tokens} token vào · ~${e.llm_completion_tokens} token ra`
]

// ─── LLM ──────────────────────────────────────────────────────────

interface FilePrompt {
  template: string
  config: Partial<AiProviderConfig>
}

const readPromptFile = (file: string): FilePrompt => {
  const parsed = matter(fs.readFileSync(file, "utf-8").replace(/\r\n?/g, "\n"))
  const fm = parsed.data as Record<string, unknown>
  return {
    template: parsed.content.trim(),
    config: {
      ...(typeof fm.provider === "string" ? { provider: fm.provider } : {}),
      ...(typeof fm.aiModel === "string" ? { model: fm.aiModel } : {}),
      ...(typeof fm.maxTokens === "number" ? { maxTokens: fm.maxTokens } : {}),
      ...(typeof fm.temperature === "number" ? { temperature: fm.temperature } : {})
    }
  }
}

const withReplyLanguage = (prompt: string, language: ReplyLanguage): string => `${prompt}\n\n${replyLanguageDirective(language)}`

const parseJson = (text: string): unknown => JSON.parse(extractJsonFromText(text, "object"))

interface Llm {
  rag: (input: AiActionInput) => Promise<{ data: KnowledgeAnswerOutput }>
  norag: (question: string, language: ReplyLanguage) => Promise<string>
  judge: (vars: Record<string, string>) => Promise<ReturnType<typeof judgeOutputSchema.parse>>
}

const makeLlm = async (opts: EvalOptions): Promise<Llm> => {
  // Cùng template + khối "Reply language" như `executeAiAction` dựng cho KNOWLEDGE_ANSWER, nhưng gọi thẳng provider
  const skill = await getPromptTemplate(ActionType.KNOWLEDGE_ANSWER)
  const norag = readPromptFile(NORAG_PROMPT_FILE)
  const judge = readPromptFile(JUDGE_PROMPT_FILE)
  const judgeConfig: AiProviderConfig = {
    provider: opts.judgeProvider ?? judge.config.provider ?? skill.providerConfig.provider,
    model: opts.judgeModel ?? judge.config.model ?? skill.providerConfig.model,
    maxTokens: judge.config.maxTokens ?? 1024,
    temperature: judge.config.temperature ?? 0,
    actionType: "knowledge_judge"
  }
  return {
    rag: async (input) => {
      const prompt = withReplyLanguage(interpolatePrompt(skill.template, input.promptVariables ?? {}), input.replyLanguage ?? "vi")
      const res = await callLLM(prompt, { ...skill.providerConfig, actionType: ActionType.KNOWLEDGE_ANSWER })
      return { data: parseResponse<KnowledgeAnswerOutput>(res.text, ActionType.KNOWLEDGE_ANSWER) }
    },
    norag: async (question, language) => {
      const prompt = withReplyLanguage(interpolatePrompt(norag.template, { question }), language)
      const res = await callLLM(prompt, { ...skill.providerConfig, ...norag.config, actionType: "knowledge_norag" })
      const out = parseJson(res.text) as { answer?: unknown }
      if (typeof out.answer !== "string") throw new Error("no-RAG trả JSON thiếu `answer`")
      return out.answer
    },
    judge: async (vars) => {
      const res = await callLLM(interpolatePrompt(judge.template, vars), judgeConfig)
      return judgeOutputSchema.parse(parseJson(res.text))
    }
  }
}

// ─── chạy ─────────────────────────────────────────────────────────

export interface AblationCell {
  chunker: ChunkerName
  mode: RetrievalMode
  chunks: number
  metrics: RetrievalMetrics
}

export interface RetrievalReport {
  ablation: AblationCell[]
  abstention: { config: string; best: AbstentionRow | null; at_current: AbstentionRow | null; rows: AbstentionRow[]; tops: { id: string; ooc: boolean; top: number | null }[] }
  per_question: { id: string; type: string; ranks: Record<string, number | null> }[]
}

export interface AnswerDetail {
  id: string
  mode: "rag" | "norag"
  question: string
  answer: string
  grounded?: boolean
  citations?: KnowledgeAnswer["citations"]
  top_vector_score?: number | null
  judge?: { correct: number; faithful: boolean | null; abstained: boolean; notes?: string } | null
  error?: string | null
}

export interface AnswersReport {
  min_score: number
  aggregate: { rag: AnswerAggregate | null; norag: AnswerAggregate | null }
  details: AnswerDetail[]
}

export interface EvalReport {
  label: string
  at: string
  corpus: string
  embedding_model: string
  questions: { total: number; in_corpus: number; out_of_corpus: number; by_type: Record<string, number> }
  estimate: CostEstimate
  retrieval?: RetrievalReport
  answers?: AnswersReport
}

const runRetrieval = async (opts: EvalOptions, cache: EmbeddingCache, docs: KnowledgeDoc[], questions: EvalQuestion[], queryVectors: number[][]): Promise<RetrievalReport> => {
  const finalChunks = chunksFor(FINAL_CHUNKER, docs)
  const finalById = new Map(finalChunks.map((c) => [c.chunk_id, c]))
  const inCorpus = questions.filter((q) => !q.out_of_corpus)
  const golds = new Map(inCorpus.map((q) => [q.id, goldSpans(q, finalById)]))
  const ablation: AblationCell[] = []
  const perQuestion = new Map(questions.map((q) => [q.id, { id: q.id, type: q.type, ranks: {} as Record<string, number | null> }]))
  let finalIndex: InProcessIndex | null = null

  for (const name of CHUNKERS) {
    opts.log(`… embed chunk của ${name}`)
    const index = await buildIndex(cache, name, name === FINAL_CHUNKER ? finalChunks : chunksFor(name, docs))
    if (name === FINAL_CHUNKER) finalIndex = index
    for (const mode of RETRIEVAL_MODES) {
      const ranks = inCorpus.map((q) => {
        const qi = questions.indexOf(q)
        const ranked = rankIn(index, queryVectors[qi]!, q.question, mode).fused.slice(0, 10)
        const rank = firstHitRank(
          ranked.map((f) => ({ chunk_id: f.chunk_id, span: index.byId.get(f.chunk_id)!.span })),
          golds.get(q.id)!
        )
        perQuestion.get(q.id)!.ranks[`${name}|${mode}`] = rank
        return rank
      })
      ablation.push({ chunker: name, mode, chunks: index.chunks.length, metrics: retrievalMetrics(ranks) })
    }
  }

  const tops = questions.map((q, i) => ({ id: q.id, ooc: q.out_of_corpus, top: rankIn(finalIndex!, queryVectors[i]!, q.question, FINAL_MODE).topCosine }))
  const sweep = sweepAbstention(tops)
  const atCurrent = sweep.rows.find((r) => Math.abs(r.threshold - opts.minScore) < 1e-9) ?? null
  return {
    ablation,
    abstention: { config: `${FINAL_CHUNKER} · ${FINAL_MODE}`, best: sweep.best, at_current: atCurrent, rows: sweep.rows, tops },
    per_question: [...perQuestion.values()]
  }
}

const runAnswers = async (opts: EvalOptions, cache: EmbeddingCache, docs: KnowledgeDoc[], questions: EvalQuestion[], queryVectors: number[][]): Promise<AnswersReport> => {
  const index = await buildIndex(cache, FINAL_CHUNKER, chunksFor(FINAL_CHUNKER, docs))
  const llm = await makeLlm(opts)
  const records: AnswerRecord[] = []
  const details: AnswerDetail[] = []
  const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

  for (const [i, q] of questions.entries()) {
    opts.log(`… ${q.id}`)
    const points = q.answer_points.map((p) => `- ${p}`).join("\n") || "(none — out of corpus)"
    if (opts.mode !== "norag") {
      const retrieval = retrievalResultFrom(index, rankIn(index, queryVectors[i]!, q.question, FINAL_MODE), opts.topK, opts.minScore)
      const labelled = labelChunks(retrieval.chunks.filter((c) => c.status === "verified"))
      let refsTotal = 0
      let refsValid = 0
      try {
        const answer = await answerFromRetrieval(q.question, retrieval, q.language, async (input) => {
          const res = await llm.rag(input)
          // Tỉ lệ nhãn hợp lệ đo TRƯỚC hậu kiểm: bao nhiêu nhãn model viết là nhãn thật của lượt này
          for (const claim of res.data.claims) for (const ref of claim.refs) {
            refsTotal++
            if (labelled.has(ref.trim().replace(/^\[|\]$/g, "").toUpperCase())) refsValid++
          }
          return res
        })
        const claims = answer.claims
          .map((c) => `- ${c.text}\n  cites: ${c.refs.map((r) => `[${r}] ${labelled.get(r)?.context_text ?? ""}`).join("\n  ")}`)
          .join("\n")
        let judge: AnswerDetail["judge"] = null
        let judgeError: string | null = null
        try {
          judge = await llm.judge({ question: q.question, answer_points: points, out_of_corpus: String(q.out_of_corpus), answer: answer.answer, claims: claims || "(none)" })
        } catch (e) {
          judgeError = `judge: ${errText(e)}`
        }
        records.push({
          id: q.id,
          mode: "rag",
          out_of_corpus: q.out_of_corpus,
          abstained: !answer.grounded,
          correct: judge ? judge.correct : null,
          faithful: answer.grounded && judge ? judge.faithful : null,
          refs_total: refsTotal,
          refs_valid: refsValid,
          error: null
        })
        details.push({ id: q.id, mode: "rag", question: q.question, answer: answer.answer, grounded: answer.grounded, citations: answer.citations, top_vector_score: retrieval.top_vector_score, judge, error: judgeError })
      } catch (e) {
        records.push({ id: q.id, mode: "rag", out_of_corpus: q.out_of_corpus, abstained: false, correct: null, faithful: null, refs_total: refsTotal, refs_valid: refsValid, error: errText(e) })
        details.push({ id: q.id, mode: "rag", question: q.question, answer: "", error: errText(e) })
      }
    }
    if (opts.mode !== "rag") {
      try {
        const answer = await llm.norag(q.question, q.language)
        let judge: AnswerDetail["judge"] = null
        let judgeError: string | null = null
        try {
          judge = await llm.judge({ question: q.question, answer_points: points, out_of_corpus: String(q.out_of_corpus), answer, claims: "(none — baseline without retrieval)" })
        } catch (e) {
          judgeError = `judge: ${errText(e)}`
        }
        records.push({
          id: q.id,
          mode: "norag",
          out_of_corpus: q.out_of_corpus,
          abstained: judge?.abstained ?? false,
          correct: judge ? judge.correct : null,
          faithful: null,
          refs_total: 0,
          refs_valid: 0,
          error: null
        })
        details.push({ id: q.id, mode: "norag", question: q.question, answer, judge, error: judgeError })
      } catch (e) {
        records.push({ id: q.id, mode: "norag", out_of_corpus: q.out_of_corpus, abstained: false, correct: null, faithful: null, refs_total: 0, refs_valid: 0, error: errText(e) })
        details.push({ id: q.id, mode: "norag", question: q.question, answer: "", error: errText(e) })
      }
    }
  }
  const rag = records.filter((r) => r.mode === "rag")
  const norag = records.filter((r) => r.mode === "norag")
  return {
    min_score: opts.minScore,
    aggregate: { rag: rag.length ? aggregateAnswers(rag) : null, norag: norag.length ? aggregateAnswers(norag) : null },
    details
  }
}

// ─── báo cáo ──────────────────────────────────────────────────────

const pct = (x: number | null): string => (x === null ? "—" : `${(x * 100).toFixed(1)}%`)
const num = (x: number | null, d = 3): string => (x === null ? "—" : x.toFixed(d))

export const renderMarkdown = (r: EvalReport): string => {
  const out: string[] = [
    `# Knowledge RAG eval — ${r.label}`,
    "",
    `- Thời điểm: ${r.at}`,
    `- Corpus: \`${r.corpus}\` · embedding: \`${r.embedding_model}\``,
    `- Câu hỏi: ${r.questions.total} (trong corpus ${r.questions.in_corpus}, ngoài corpus ${r.questions.out_of_corpus}) — ${Object.entries(r.questions.by_type).map(([t, n]) => `${t} ${n}`).join(", ")}`,
    `- Ước lượng: ${r.estimate.embedding_texts} text embed (~${r.estimate.embedding_tokens} token), ${r.estimate.llm_calls} lượt LLM`,
    ""
  ]
  if (r.retrieval) {
    out.push("## Ablation truy hồi (trùng khớp theo khoảng chữ ≥ 50% chunk vàng)", "", "| Chunker | Truy hồi | Chunk | R@1 | R@3 | R@5 | MRR@10 |", "|---|---|---:|---:|---:|---:|---:|")
    for (const c of r.retrieval.ablation) {
      out.push(`| ${c.chunker} | ${c.mode} | ${c.chunks} | ${pct(c.metrics.recall_at_1)} | ${pct(c.metrics.recall_at_3)} | ${pct(c.metrics.recall_at_5)} | ${num(c.metrics.mrr_at_10)} |`)
    }
    const a = r.retrieval.abstention
    out.push("", `## Ngưỡng từ chối (${a.config}, top cosine, quét 0,40–0,85)`, "")
    const row = (label: string, x: AbstentionRow | null): string =>
      x ? `| ${label} | ${x.threshold.toFixed(2)} | ${num(x.f1)} | ${num(x.precision)} | ${num(x.recall)} | ${pct(x.in_corpus_answered)} | ${pct(x.out_of_corpus_abstained)} |` : `| ${label} | — | — | — | — | — | — |`
    out.push("| | Ngưỡng | F1 | Precision | Recall | Trong corpus được trả lời | Ngoài corpus bị từ chối |", "|---|---:|---:|---:|---:|---:|---:|", row("Tốt nhất (chọn)", a.best), row("KNOWLEDGE_MIN_SCORE hiện tại", a.at_current))
  }
  if (r.answers) {
    const g = r.answers.aggregate
    out.push("", `## Câu trả lời (ngưỡng ${r.answers.min_score})`, "", "| | RAG | no-RAG |", "|---|---:|---:|")
    out.push(`| Đúng (trung bình answer_points, câu trong corpus; từ chối = 0) | ${pct(g.rag?.correctness ?? null)} | ${pct(g.norag?.correctness ?? null)} |`)
    out.push(`| Câu trong corpus được trả lời | ${pct(g.rag?.in_corpus_answered ?? null)} | ${pct(g.norag?.in_corpus_answered ?? null)} |`)
    out.push(`| Trung thực (mọi ý được chunk trích đỡ) | ${pct(g.rag?.faithfulness ?? null)} | — |`)
    out.push(`| Ảo giác ngoài corpus (trả lời thay vì từ chối) | ${pct(g.rag?.out_of_corpus_hallucination ?? null)} | ${pct(g.norag?.out_of_corpus_hallucination ?? null)} |`)
    out.push(`| Nhãn trích dẫn hợp lệ (code) | ${pct(g.rag?.citation_validity ?? null)} | — |`)
    out.push(`| Lỗi | ${g.rag?.errors ?? "—"} | ${g.norag?.errors ?? "—"} |`)
  }
  return `${out.join("\n")}\n`
}

export const runKnowledgeEval = async (opts: EvalOptions): Promise<{ report: EvalReport; markdown: string; files: { md: string; json: string } }> => {
  if (!embeddingAvailable()) throw new Error("Embedding chưa bật (EMBEDDING_PROVIDER=off hoặc thiếu GEMINI_API_KEY) — eval cần embedding")
  const { corpus, questions } = loadQuestions(opts.questionsFile, opts)
  const docs = loadCorpus(opts.dir, { corpus })
  const sets = opts.retrievalOnly ? CHUNKERS.map((c) => chunksFor(c, docs)) : [chunksFor(FINAL_CHUNKER, docs)]
  const tpl = async (): Promise<{ rag: number; norag: number; judge: number }> => ({
    rag: estimateTokens((await getPromptTemplate(ActionType.KNOWLEDGE_ANSWER)).template),
    norag: estimateTokens(readPromptFile(NORAG_PROMPT_FILE).template),
    judge: estimateTokens(readPromptFile(JUDGE_PROMPT_FILE).template)
  })
  const estimate = estimateCost(opts, sets, questions, opts.retrievalOnly ? { rag: 0, norag: 0, judge: 0 } : await tpl())
  opts.log(`Embedding: ${embeddingProvider()} (${embeddingModelId()}) · LLM override: ${env.AI_PROVIDER_OVERRIDE || "(theo frontmatter)"}`)
  for (const line of formatEstimate(estimate)) opts.log(line)

  const cache = createEmbeddingCache(opts.cacheFile)
  if (opts.seedCacheFromDb) opts.log(`Nạp ${await seedCacheFromDb(cache, corpus)} vector đã ingest từ knowledge_chunks vào cache`)
  const queryVectors = await cache.embed(
    questions.map((q) => q.question),
    "RETRIEVAL_QUERY"
  )
  const byType: Record<string, number> = {}
  for (const q of questions) byType[q.type] = (byType[q.type] ?? 0) + 1
  const report: EvalReport = {
    label: opts.label,
    at: new Date().toISOString(),
    corpus,
    embedding_model: embeddingModelId(),
    questions: { total: questions.length, in_corpus: questions.filter((q) => !q.out_of_corpus).length, out_of_corpus: questions.filter((q) => q.out_of_corpus).length, by_type: byType },
    estimate,
    ...(opts.retrievalOnly ? { retrieval: await runRetrieval(opts, cache, docs, questions, queryVectors) } : { answers: await runAnswers(opts, cache, docs, questions, queryVectors) })
  }
  const cached = cache.stats()
  opts.log(`Cache embedding: ${cached.hits} lấy từ cache · ${cached.misses} embed mới`)
  const markdown = renderMarkdown(report)
  fs.mkdirSync(opts.outDir, { recursive: true })
  const base = path.join(opts.outDir, `knowledge-eval-${opts.label}-${report.at.replace(/[:.]/g, "-")}`)
  const files = { md: `${base}.md`, json: `${base}.json` }
  fs.writeFileSync(files.md, markdown)
  fs.writeFileSync(files.json, JSON.stringify(report, null, 2))
  opts.log(markdown)
  opts.log(`Đã ghi ${files.md} và ${files.json}`)
  return { report, markdown, files }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runKnowledgeEval(parseEvalArgs(process.argv.slice(2))).catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
