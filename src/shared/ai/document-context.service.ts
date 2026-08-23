/**
 * Task 2c — Context Builder theo Action + SectionType
 *
 * Xác định action/section nào cần đọc tài liệu nguồn (uploaded documents)
 * và build đoạn text context phù hợp để chèn vào prompt AI.
 *
 * Điều chỉnh nghiệp vụ (đã được phê duyệt):
 * - Phân loại theo SectionType cho GENERATE_SECTION (không phải chỉ theo actionType)
 * - Các action khác giữ logic action-level
 */

import { ActionType } from "./ai-action.types.js"
import { ProjectDocument } from "../../modules/project/project-document.model.js"

// ─── SectionType needs-source map ────────────────────────────────────────────

/**
 * Map phân loại từng SectionType có cần đọc tài liệu nguồn upload hay không.
 *
 * true  = section này dựa vào thông tin gốc từ tài liệu của khách hàng
 *         (meeting notes, BRD, brief, etc.)
 * false = section này dựa vào nội dung đã sinh trước đó trong hệ thống
 *         (các section khác, priority ranking, v.v.) — không cần raw document
 */
export const SECTION_NEEDS_SOURCE_DOCUMENTS: Record<string, boolean> = {
  // ─── Phase 2 (Foundation & Overview) ───
  vision_problem: true,
  business_goals: true,
  value_proposition: true,
  high_level_business_rules: true, // Trích xuất từ tài liệu BRD / brief
  stakeholders: true,
  user_journey: true,
  use_case_spec: false, // Dựa vào actors + user journey đã làm rõ

  // ─── Phase 3 (Core Functional Specification) ───
  screen_flow: false, // Dựa vào user_journey & use_case_spec
  screen_description: false, // Dựa vào screen_flow & functional_requirements
  rbac: false, // Dựa vào functional_requirements + stakeholders
  non_screen_functions: false, // Dựa vào functional_requirements & system architecture
  erd: false, // Dựa vào functional_requirements & entity structures
  functional_requirements: true, // Cần đối chiếu với tài liệu gốc của khách hàng
  user_story: false, // Dựa vào functional_requirements
  acceptance_criteria: false, // Dựa vào functional_requirements & user_story
  priority_ranking: false, // Dựa vào functional_requirements (MoSCoW)
  scope_out_of_scope: false, // Dựa vào priority_ranking (Must/Should/Won't)

  // ─── Phase 4 (Non-functional & Finalization) ───
  external_interfaces: true, // Trích xuất từ BRD / tài liệu tích hợp API
  non_functional_requirements: true, // Trích xuất SLA, bảo mật, tải từ tài liệu
  common_business_rules: false, // Tổng hợp, chuẩn hoá quy tắc chung từ FR & High-level BR
  common_requirements: false, // Chuẩn hoá yêu cầu hệ thống (logging, auditing, i18n)
  application_messages: false, // Dựa vào functional_requirements & business rules
  assumptions_risks: true, // Trích xuất từ tài liệu dự án
  glossary: true, // Quét tài liệu gốc để bắt thuật ngữ chuyên ngành
  success_metrics: false // Dựa vào business_goals đã có
}

// ─── Action-level: các action ngoài GENERATE_SECTION ─────────────────────────

/**
 * Với các action không phải GENERATE_SECTION, phân loại theo action-level:
 * true = luôn cần documents (Discovery phase actions)
 * false = không cần documents
 */
const ACTION_NEEDS_SOURCE_DOCUMENTS: Record<string, boolean> = {
  [ActionType.SUMMARIZE]: true,
  [ActionType.EXTRACT]: true,
  [ActionType.ANALYSIS]: true,
  [ActionType.CLARIFICATION]: true,
  [ActionType.CHAT]: true,
  [ActionType.SUMMARIZE_DOCUMENT]: true,
  // Actions dưới đây không cần document gốc:
  [ActionType.VERIFICATION]: false,
  [ActionType.REWRITE]: false,
  [ActionType.DIAGRAM_CLASSIFY]: false,
  [ActionType.DIAGRAM_GENERATE]: false,
  [ActionType.PRIORITY_RANKING]: false,
  [ActionType.SCOPE_OUT_OF_SCOPE]: false,
  [ActionType.GENERATE_DIAGRAM]: false
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
  "gemini-2.0-flash": 1000000,
  "gemini-1.5-pro": 1000000
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
 * @param sectionType    - SectionType (bắt buộc khi actionType === GENERATE_SECTION)
 * @param chatHistoryTokens - Token ước lượng của chat history hiện có (cho CHAT action)
 * @param modelName      - Tên model AI đang dùng (để tính context window)
 * @param maxOutputTokens - maxTokens output dự kiến (từ PromptTemplate config)
 */
export const buildDocumentContext = async (
  projectId: string,
  actionType: string,
  sectionType?: string,
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

  let needsDocs: boolean

  if (actionType === ActionType.GENERATE_SECTION) {
    if (!sectionType) {
      // Không có sectionType → không biết phân loại → an toàn là không load
      console.warn("[DocumentContext] GENERATE_SECTION called without sectionType — skipping document context")
      return empty
    }
    needsDocs = SECTION_NEEDS_SOURCE_DOCUMENTS[sectionType] ?? false
  } else {
    needsDocs = ACTION_NEEDS_SOURCE_DOCUMENTS[actionType] ?? false
  }

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
