/**
 * Context tài liệu upload cho prompt.
 *
 * Chỉ gửi `extractedText`/`summary` đã parse cho model (giả định 10 của plan) — không gửi file gốc.
 * Step pipeline đọc tài liệu khi `reads` của step có token `documents` (step registry, T12);
 * action ngoài pipeline (CHAT, SUMMARIZE_DOCUMENT) phân loại theo action.
 */

import { ActionType } from "./ai-action.types.js"
import { ProjectDocument } from "../../modules/project/project-document.model.js"
import { DOCUMENTS_READ, getStep } from "../../modules/pipeline/step-registry.js"
import { ApiError } from "../utils/api-error.js"

// ─── Action-level: các action ngoài pipeline ────────────────────────────────

/** true = cần documents; action không có trong bảng ⇒ không nạp. */
const ACTION_NEEDS_SOURCE_DOCUMENTS: Record<string, boolean> = {
  [ActionType.CHAT]: true,
  [ActionType.SUMMARIZE_DOCUMENT]: true
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

// ─── Context window estimates per model ──────────────────────────────────────

/**
 * Context window (tokens) theo từng model.
 * Dùng để tính token budget còn lại cho documents.
 * Giá trị an toàn — thực tế có thể lớn hơn nhưng không nên dùng hết.
 */
const CONTEXT_WINDOW_BY_MODEL: Record<string, number> = {
  "gpt-4o": 128000,
  "gpt-4o-mini": 128000,
  "claude-3-5-sonnet": 200000,
  "claude-haiku-4-5-20251001": 200000,
  "claude-haiku-4-5": 200000,
  "gemini-3.5-flash": 1000000,
  "gemini-3.5": 1000000,
  "gemini-2.0-flash": 1000000,
  "gemini-1.5-pro": 1000000,
  "zai-org/GLM-5.3-Flash": 128000,
  "GLM-5.3-Flash": 128000,
  "glm": 128000
}

const DEFAULT_CONTEXT_WINDOW = 32000  // an toàn cho mọi model không xác định

// Hao hụt dự phòng: system prompt + response + overhead
const SAFETY_BUFFER_TOKENS = 4000
const DEFAULT_MAX_OUTPUT_TOKENS = 3000

const getContextWindow = (model?: string): number => {
  if (!model) return DEFAULT_CONTEXT_WINDOW
  // tìm match theo prefix nếu không có exact match
  for (const [key, value] of Object.entries(CONTEXT_WINDOW_BY_MODEL)) {
    if (model.startsWith(key) || key.startsWith(model)) return value
  }
  return DEFAULT_CONTEXT_WINDOW
}

// ─── Main export ─────────────────────────────────────────────────────────────

export interface DocumentContextResult {
  contextText: string        // đoạn text sẵn sàng chèn vào prompt
  tokenCount: number         // ước lượng số token của contextText
  documentsUsed: number      // số document được đưa vào context
  usedSummary: boolean       // true nếu dùng summary thay vì full extractedText
}

/**
 * Build context text từ tài liệu đã upload của project.
 *
 * @param projectId      - ID của project
 * @param actionType     - ActionType đang được thực hiện
 * @param stepId         - Step id khi actionType là action Draft của pipeline
 * @param chatHistoryTokens - Token ước lượng của chat history hiện có (cho CHAT action)
 * @param modelName      - Tên model AI đang dùng (để tính context window)
 * @param maxOutputTokens - maxTokens output dự kiến (từ frontmatter của prompt/skill)
 */
export const buildDocumentContext = async (
  projectId: string,
  actionType: string,
  stepId?: string,
  chatHistoryTokens: number = 0,
  modelName?: string,
  maxOutputTokens: number = DEFAULT_MAX_OUTPUT_TOKENS
): Promise<DocumentContextResult> => {
  const empty: DocumentContextResult = {
    contextText: "",
    tokenCount: 0,
    documentsUsed: 0,
    usedSummary: false
  }

  // ─── Xác định cần document hay không ──────────────────────────────────────

  const needsDocs = PIPELINE_DRAFT_ACTIONS.has(actionType)
    ? stepId !== undefined && stepNeedsSourceDocuments(stepId)
    : ACTION_NEEDS_SOURCE_DOCUMENTS[actionType] ?? false

  if (!needsDocs) return empty

  // ─── Lấy documents đã parse thành công ────────────────────────────────────

  const documents = await ProjectDocument.find({
    projectId,
    parseStatus: "success"
  }).select("_id originalName extractedText summary summaryStatus tokenCount").lean()

  if (documents.length === 0) return empty

  // ─── Tính token budget còn lại ────────────────────────────────────────────

  const contextWindow = getContextWindow(modelName)
  // Budget = contextWindow - safety_buffer - chatHistory - maxOutput dự kiến
  // System prompt overhead ước lượng ~500 tokens
  const systemPromptEstimate = 500
  const availableBudget = contextWindow - SAFETY_BUFFER_TOKENS - systemPromptEstimate - chatHistoryTokens - maxOutputTokens

  if (availableBudget <= 0) {
    console.warn(`[DocumentContext] Token budget exhausted (available=${availableBudget}) — skipping document context`)
    return empty
  }

  // ─── Quyết định dùng extractedText hay summary ────────────────────────────

  const totalExtractedTokens = documents.reduce((sum, doc) => sum + (doc.tokenCount || 0), 0)
  const useSummary = totalExtractedTokens > availableBudget

  // ─── Build context text ───────────────────────────────────────────────────

  const parts: string[] = []
  let totalTokens = 0
  let usedSummary = false

  for (const doc of documents) {
    const docName = doc.originalName || "document"
    const docId = doc._id.toString()

    let content: string | null = null

    if (!useSummary) {
      // Dùng full text nếu trong ngưỡng
      content = doc.extractedText || null
    } else {
      // Dùng summary nếu vượt ngưỡng
      usedSummary = true
      if (doc.summaryStatus === "success" && doc.summary) {
        content = doc.summary
      } else {
        // Fallback: nếu summary chưa có → dùng extractedText (có thể vẫn vượt ngưỡng, nhưng tốt hơn bỏ qua)
        content = doc.extractedText || null
        if (content) {
          console.warn(`[DocumentContext] Summary unavailable for "${docName}", falling back to extractedText`)
        }
      }
    }

    if (!content) continue

    const snippet = `[Nguồn: ${docName} | documentId: ${docId}]\n${content}`
    const snippetTokens = Math.ceil(snippet.length / 4)

    // Dừng nếu thêm document này sẽ vượt budget
    if (totalTokens + snippetTokens > availableBudget) {
      console.warn(`[DocumentContext] Budget limit reached at doc "${docName}" — truncating document list`)
      break
    }

    parts.push(snippet)
    totalTokens += snippetTokens
  }

  if (parts.length === 0) return empty

  const contextText = `\n\n--- TÀI LIỆU THAM KHẢO (Source Documents) ---\n${parts.join("\n\n")}\n--- HẾT TÀI LIỆU ---\n`

  return {
    contextText,
    tokenCount: totalTokens,
    documentsUsed: parts.length,
    usedSummary
  }
}
