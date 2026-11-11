/**
 * Context tài liệu upload cho prompt.
 *
 * Chỉ gửi chữ đã parse cho model (giả định 10 của plan) — không gửi file gốc.
 * Step pipeline đọc tài liệu khi `reads` của step có token `documents` (step registry, T12);
 * action ngoài pipeline (CHAT) phân loại theo action.
 *
 * FLF-393 — không còn "quẳng cả cục" tài liệu vào mỗi lượt gọi:
 * - Ngân sách là **trần token cố định theo loại lượt gọi** (`DOC_CONTEXT_*_TOKENS`), không phải context window của model
 *   (model 1M token từng cho lọt nguyên SRS 500 trang vào mỗi tin chat).
 * - Tổng tài liệu ≤ trần ⇒ gửi nguyên văn như trước (`mode = "full"`): biên bản họp, email ngắn không đổi hành vi.
 * - Vượt trần ⇒ `mode = "retrieved"`: chỉ gửi chunk liên quan — chunk có tiêu đề khớp section step nuôi (tất định) rồi
 *   top-k BM25 theo câu hỏi (`document-retrieval/`). Câu hỏi toàn cục / không tìm được gì ⇒ kèm tóm tắt từng tài liệu.
 * - Mã đoạn `D<n>-P<m>` (FLF-292) giữ nguyên ở mọi chế độ: chunk chỉ là một khoảng đoạn của `splitParagraphs`.
 * - Có tài liệu đã parse thì context **không bao giờ rỗng** (B-0.1 `hasIdea`, `has_documents` của skill dựa vào đó).
 */

import { env } from "../../config/env.js"
import { ActionType } from "./ai-action.types.js"
import { ProjectDocument } from "../../modules/project/project-document.model.js"
import { DOCUMENTS_READ, getStep } from "../../modules/pipeline/step-registry.js"
import { ApiError } from "../utils/api-error.js"
import { assignDocCodes } from "../../modules/project/document-code.service.js"
import { formatCodedParagraphs, paragraphId } from "./document-paragraphs.js"
import { searchBm25 } from "./document-retrieval/bm25.js"
import { estimateDocTokens } from "./document-retrieval/chunker.js"
import { loadProjectIndex, type IndexedChunk } from "./document-retrieval/chunk-index.service.js"
import { isGlobalQuestion } from "./document-retrieval/query.js"
import { headChunks, pinnedChunkIds, selectChunks } from "./document-retrieval/select.js"
import { tokenize } from "./document-retrieval/vi-tokenizer.js"

// ─── Action-level: các action ngoài pipeline ────────────────────────────────

/**
 * true = cần documents; action không có trong bảng ⇒ không nạp. `SUMMARIZE_DOCUMENT` không đi qua đây: lượt tóm tắt nhận
 * thẳng chữ của chính tài liệu vừa upload (`project-document.service.ts`).
 */
const ACTION_NEEDS_SOURCE_DOCUMENTS: Record<string, boolean> = {
  [ActionType.CHAT]: true
}

// ─── Step-level: Draft của pipeline (T11) ────────────────────────────────────

/** Action pipeline dựng context theo step (tham số `stepId`). */
const PIPELINE_DRAFT_ACTIONS: ReadonlySet<string> = new Set([
  ActionType.DRAFT,
  ActionType.REGENERATE,
  ActionType.REVISION
])

/**
 * Step nào đọc tài liệu upload: step registry (T12) ghi token `documents` trong `reads`. Step suy dẫn
 * từ Spine đã có (S-3.4, S-4.2, S-7.1…) không có token này. Id không phải step ⇒ không nạp.
 */
export const stepNeedsSourceDocuments = (stepId: string): boolean => {
  try {
    return getStep(stepId).reads.includes(DOCUMENTS_READ)
  } catch (err) {
    if (err instanceof ApiError) return false
    throw err
  }
}

// ─── Ngân sách ───────────────────────────────────────────────────────────────

/** Trần token tài liệu của lượt gọi. */
export const documentBudgetFor = (actionType: string): number =>
  PIPELINE_DRAFT_ACTIONS.has(actionType) ? env.DOC_CONTEXT_DRAFT_TOKENS : env.DOC_CONTEXT_CHAT_TOKENS

/** Số ứng viên BM25 lấy ra trước khi chọn (chunk ghim cần điểm để xếp khi ghim nhiều hơn ngân sách). */
const BM25_CANDIDATES = 200
/** Phần ngân sách tối đa dành cho tóm tắt khi kèm tóm tắt. */
const SUMMARY_BUDGET_SHARE = 0.3

const HEADER = "--- TÀI LIỆU THAM KHẢO (Source Documents) ---"
const FOOTER = "--- HẾT TÀI LIỆU ---"
const EXCERPT_NOTE =
  "(Tài liệu đã tải lên quá dài nên dưới đây chỉ là các trích đoạn liên quan nhất tới lượt này; tài liệu còn những phần khác không hiển thị. " +
  "Only the most relevant excerpts of the uploaded documents are shown — other parts exist but are not included; do not conclude that something is absent from the documents.)"

// ─── Main export ─────────────────────────────────────────────────────────────

export type DocumentContextMode = "none" | "full" | "retrieved"

export interface DocumentContextRequest {
  projectId: string
  /** ActionType đang thực hiện. */
  actionType: string
  /** Step id khi actionType là action Draft của pipeline. */
  stepId?: string
  /** Câu hỏi tìm đoạn khi tài liệu vượt trần: tin nhắn của user (chat) / nhãn step + tên phần tử + câu trả lời (step). */
  query?: string
  /** Tiêu đề (mọi tên gọi) của các section step nuôi — chunk có tiêu đề khớp được lấy trước, không qua tìm kiếm. */
  sectionTitles?: readonly string[]
}

export interface DocumentContextResult {
  contextText: string        // đoạn text sẵn sàng chèn vào prompt
  tokenCount: number         // ước lượng số token của contextText (ký tự / 3)
  documentsUsed: number      // số document được đưa vào context
  usedSummary: boolean       // true nếu có kèm tóm tắt tài liệu
  mode: DocumentContextMode
  /** Số chunk được chọn (`mode = "retrieved"`). */
  chunksUsed: number
  /** Ước lượng token nếu gửi nguyên văn mọi tài liệu — để đo mức tiết kiệm. */
  fullTokens: number
}

const EMPTY: DocumentContextResult = { contextText: "", tokenCount: 0, documentsUsed: 0, usedSummary: false, mode: "none", chunksUsed: 0, fullTokens: 0 }

interface DocumentRow {
  _id: { toString(): string }
  originalName?: string | null
  summary?: string | null
  summaryStatus?: string | null
  tokenCount?: number | null
  docCode?: number | null
}

const wrap = (parts: readonly string[], note?: string): string => `\n\n${HEADER}\n${note ? `${note}\n\n` : ""}${parts.join("\n\n")}\n${FOOTER}\n`

const nameOf = (doc: DocumentRow): string => doc.originalName || "document"

/** `tokenCount` lưu lúc parse là ký tự / 4 ⇒ đổi sang thước ký tự / 3 của ngân sách; chưa có ⇒ `null` (phải đọc chữ mới biết). */
const approxFullTokens = (docs: readonly DocumentRow[]): number | null => {
  let total = 0
  for (const doc of docs) {
    if (doc.tokenCount === null || doc.tokenCount === undefined) return null
    total += Math.ceil((doc.tokenCount * 4) / 3)
  }
  return total
}

/** Nguyên văn mọi tài liệu, đúng khuôn trước FLF-393. `null` = không có chữ nào. */
const buildFull = async (docs: readonly DocumentRow[]): Promise<{ text: string; documentsUsed: number } | null> => {
  const texts = await ProjectDocument.find({ _id: { $in: docs.map((d) => d._id.toString()) } })
    .select("_id extractedText")
    .lean()
  const textById = new Map(texts.map((t) => [t._id.toString(), t.extractedText ?? ""]))
  const parts: string[] = []
  for (const doc of docs) {
    const text = textById.get(doc._id.toString())
    if (!text) continue
    // FLF-292: mỗi đoạn mang mã `D<n>-P<m>` để model trích làm nguồn
    const content = doc.docCode ? formatCodedParagraphs(doc.docCode, text) : text
    const codeLabel = doc.docCode ? ` | mã tài liệu: D${doc.docCode}` : ""
    parts.push(`[Nguồn: ${nameOf(doc)} | documentId: ${doc._id.toString()}${codeLabel}]\n${content}`)
  }
  return parts.length ? { text: wrap(parts), documentsUsed: parts.length } : null
}

const renderChunk = (chunk: IndexedChunk): string => {
  const section = chunk.heading_path.length ? ` | mục: ${chunk.heading_path.join(" > ")}` : ""
  const range = `${paragraphId(chunk.docCode, chunk.p_start)}…${paragraphId(chunk.docCode, chunk.p_end)}`
  const body = chunk.paragraphs.map((p, i) => `[${paragraphId(chunk.docCode, chunk.p_start + i)}] ${p}`).join("\n")
  return `[Nguồn: ${chunk.docName} | documentId: ${chunk.documentId} | mã tài liệu: D${chunk.docCode}${section} | đoạn ${range}]\n${body}`
}

/** Tóm tắt của từng tài liệu, cắt cho vừa `maxTokens` (chia đều). Tài liệu chưa có tóm tắt bị bỏ. */
const buildSummaries = (docs: readonly DocumentRow[], maxTokens: number): string[] => {
  const withSummary = docs.filter((d) => d.summaryStatus === "success" && d.summary)
  if (!withSummary.length) return []
  const charsEach = Math.floor((maxTokens * 3) / withSummary.length) - 80
  if (charsEach <= 0) return []
  return withSummary.map((d) => {
    const summary = d.summary!.length > charsEach ? `${d.summary!.slice(0, charsEach)}…` : d.summary!
    return `[Tóm tắt tài liệu: ${nameOf(d)}${d.docCode ? ` | mã tài liệu: D${d.docCode}` : ""}]\n${summary}`
  })
}

/**
 * Build context text từ tài liệu đã upload của project.
 */
export const buildDocumentContext = async (request: DocumentContextRequest): Promise<DocumentContextResult> => {
  const { projectId, actionType, stepId } = request

  // ─── Xác định cần document hay không ──────────────────────────────────────

  const isStepCall = PIPELINE_DRAFT_ACTIONS.has(actionType)
  const needsDocs = isStepCall ? stepId !== undefined && stepNeedsSourceDocuments(stepId) : (ACTION_NEEDS_SOURCE_DOCUMENTS[actionType] ?? false)
  if (!needsDocs) return EMPTY

  // ─── Lấy documents đã parse thành công (chưa đọc chữ — tài liệu lớn không nạp vào RAM mỗi lượt) ───────────

  // FLF-292: tài liệu cũ chưa có số ⇒ gán bù trước khi đọc, để mã đoạn trong prompt ổn định qua các lượt
  await assignDocCodes(projectId)
  const documents: DocumentRow[] = await ProjectDocument.find({ projectId, parseStatus: "success" })
    .select("_id originalName summary summaryStatus tokenCount docCode")
    .sort({ docCode: 1, createdAt: 1 })
    .lean()
  if (documents.length === 0) return EMPTY

  const budget = documentBudgetFor(actionType)

  // ─── Vừa trần ⇒ nguyên văn ────────────────────────────────────────────────

  const approx = approxFullTokens(documents)
  if (approx === null || approx <= budget) {
    const full = await buildFull(documents)
    if (!full) return EMPTY
    const tokens = estimateDocTokens(full.text)
    if (tokens <= budget) {
      return { contextText: full.text, tokenCount: tokens, documentsUsed: full.documentsUsed, usedSummary: false, mode: "full", chunksUsed: 0, fullTokens: tokens }
    }
  }

  // ─── Vượt trần ⇒ chỉ đoạn liên quan ───────────────────────────────────────

  const refs = documents.filter((d) => d.docCode).map((d) => ({ id: d._id.toString(), docCode: d.docCode as number, name: nameOf(d) }))
  const index = await loadProjectIndex(refs)
  const fullTokens = approx ?? index.chunks.reduce((sum, c) => sum + c.tokens, 0)

  const query = request.query?.trim() ?? ""
  const ranked = query ? searchBm25(index.bm25, tokenize(query), BM25_CANDIDATES) : []
  const pinnedIds = pinnedChunkIds(index.chunks, request.sectionTitles ?? [])

  // Tóm tắt đi kèm khi tìm đoạn không đủ trả lời: câu hỏi toàn cục, không khớp gì, hoặc step không nuôi mục nào của
  // tài liệu (Brief, S-1 đọc rộng) — BM25 không trả lời được câu hỏi về cả tài liệu.
  const wantSummary = (!isStepCall && isGlobalQuestion(query)) || (ranked.length === 0 && pinnedIds.length === 0) || (isStepCall && pinnedIds.length === 0)
  const header = estimateDocTokens(`${HEADER}\n${EXCERPT_NOTE}\n${FOOTER}`) + 8
  const summaries = wantSummary ? buildSummaries(documents, Math.floor((budget - header) * SUMMARY_BUDGET_SHARE)) : []
  const summaryTokens = summaries.reduce((sum, s) => sum + estimateDocTokens(s) + 1, 0)
  const chunkBudget = Math.max(0, budget - header - summaryTokens)

  let selected = selectChunks({ chunks: index.chunks, ranked, pinnedIds, maxTokens: chunkBudget, topK: env.DOC_CONTEXT_TOP_K })
  // Không tìm được gì và không có tóm tắt ⇒ phần đầu tài liệu, để context không rỗng
  if (!selected.length && !summaries.length) selected = headChunks(index.chunks, chunkBudget)
  if (!selected.length && !summaries.length) return { ...EMPTY, fullTokens }

  // Trần là cứng: token chunk là ước lượng lúc cắt (nhãn mục dài có thể dôi ra) ⇒ đo lại chữ thật, dôi thì bớt chunk cuối
  let contextText = wrap([...summaries, ...selected.map(renderChunk)], EXCERPT_NOTE)
  let tokenCount = estimateDocTokens(contextText)
  while (tokenCount > budget && selected.length > 0) {
    selected = selected.slice(0, -1)
    contextText = wrap([...summaries, ...selected.map(renderChunk)], EXCERPT_NOTE)
    tokenCount = estimateDocTokens(contextText)
  }
  const documentsUsed = new Set(selected.map((c) => c.documentId)).size || summaries.length

  console.log(
    `[DocumentContext] action=${actionType}${stepId ? ` step=${stepId}` : ""} mode=retrieved chunks=${selected.length}/${index.chunks.length}` +
      ` pinned=${pinnedIds.length} summary=${summaries.length} tokens=${tokenCount}/${budget} full=${fullTokens}`
  )

  return { contextText, tokenCount, documentsUsed, usedSummary: summaries.length > 0, mode: "retrieved", chunksUsed: selected.length, fullTokens }
}
