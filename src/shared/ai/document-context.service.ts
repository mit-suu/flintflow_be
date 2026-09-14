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
import { DOCUMENTS_READ, getStep } from "../../modules/pipeline/step-registry.js"
import { ApiError } from "../utils/api-error.js"

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
  [ActionType.CHAT]: true,
  [ActionType.SUMMARIZE_DOCUMENT]: true,
  // Actions dưới đây không cần document gốc:
  [ActionType.DIAGRAM_CLASSIFY]: false,
  [ActionType.DIAGRAM_GENERATE]: false,
  [ActionType.PRIORITY_RANKING]: false,
  [ActionType.SCOPE_OUT_OF_SCOPE]: false,
}

// ─── Step-level: Draft của pipeline (T11) ────────────────────────────────────

/** Action pipeline dựng context theo step (tham số `sectionType` mang step id). */
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
  } else if (PIPELINE_DRAFT_ACTIONS.has(actionType)) {
    needsDocs = sectionType ? stepNeedsSourceDocuments(sectionType) : false
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

// ─── Context Chaining: Gom Sections đã Accept từ Phase trước ─────────────────

import { Section } from "../../modules/specification/section.model.js"
import { SECTION_METADATA, WORKSPACE_PHASE_MAP, type SectionType as SectionTypeKey } from "../constants/section-types.js"

/**
 * Map từ phase number → WorkspacePhase key trước đó.
 * Phase 3 cần đọc Phase 2, Phase 4 cần đọc Phase 2 + 3.
 */
const PRIOR_PHASES_FOR: Record<number, string[]> = {
  2: [],                                    // Phase 2 không cần phase trước (đọc từ documents)
  3: ["product_overview"],                  // Phase 3 cần Phase 2
  4: ["product_overview", "functional_spec"] // Phase 4 cần Phase 2 + 3
}

export interface PriorPhaseContextResult {
  contextText: string       // đoạn text chèn vào prompt
  tokenCount: number        // ước lượng token
  sectionsUsed: number      // số section đưa vào context
}

/**
 * Build context text từ các Section đã accepted ở Phase trước.
 * Được gọi khi generateSection cho Section thuộc Phase 3 hoặc 4.
 *
 * Cơ chế token budget:
 * - Ước lượng ~4 ký tự = 1 token.
 * - Giới hạn tối đa maxTokenBudget (mặc định 8000 tokens ≈ 32KB text).
 * - Nếu vượt budget → cắt ngắn từng section thay vì bỏ qua.
 *
 * @param projectId     - ID của project
 * @param sectionType   - SectionType đang được sinh (dùng để xác định phase hiện tại)
 * @param maxTokenBudget - Token budget tối đa cho phần context này (mặc định 8000)
 */
export const buildPriorPhaseSectionsContext = async (
  projectId: string,
  sectionType: string,
  maxTokenBudget: number = 8000
): Promise<PriorPhaseContextResult> => {
  const empty: PriorPhaseContextResult = { contextText: "", tokenCount: 0, sectionsUsed: 0 }

  // Xác định phase của section đang được sinh
  const meta = SECTION_METADATA[sectionType as SectionTypeKey]
  if (!meta) return empty

  const currentPhase = meta.phase
  const priorPhaseKeys = PRIOR_PHASES_FOR[currentPhase]
  if (!priorPhaseKeys || priorPhaseKeys.length === 0) return empty

  // Gom danh sách section types từ các phase trước
  const priorSectionTypes: string[] = []
  for (const phaseKey of priorPhaseKeys) {
    const phaseConfig = WORKSPACE_PHASE_MAP[phaseKey as keyof typeof WORKSPACE_PHASE_MAP]
    if (phaseConfig?.sectionTypes) {
      priorSectionTypes.push(...phaseConfig.sectionTypes)
    }
  }

  if (priorSectionTypes.length === 0) return empty

  // Query các section đã accepted hoặc đã có content
  const sections = await Section.find({
    projectId,
    type: { $in: priorSectionTypes as SectionTypeKey[] },
    status: { $in: ["accepted", "draft", "edited_manually"] },
    content: { $exists: true, $ne: "" }
  }).sort({ order: 1 }).lean()

  if (sections.length === 0) return empty

  // Build context string với token budget
  const parts: string[] = []
  let totalTokens = 0
  let sectionsUsed = 0

  for (const section of sections) {
    const sectionMeta = SECTION_METADATA[section.type as SectionTypeKey]
    const label = sectionMeta?.label || section.type
    const statusTag = section.status === "accepted" ? "✅ Accepted" : "📝 Draft"

    let content = typeof section.content === "string"
      ? section.content
      : JSON.stringify(section.content, null, 2)

    // Ước lượng token cho snippet header + content
    const headerText = `[${statusTag}] ${label}`
    const snippetTokens = Math.ceil((headerText.length + content.length + 10) / 4)

    // Nếu vượt budget → cắt ngắn content
    if (totalTokens + snippetTokens > maxTokenBudget) {
      const remainingTokenBudget = maxTokenBudget - totalTokens - Math.ceil(headerText.length / 4) - 20
      if (remainingTokenBudget <= 100) break // Không còn đủ chỗ

      const maxChars = remainingTokenBudget * 4
      content = content.substring(0, maxChars) + "\n...(truncated for token budget)"
    }

    parts.push(`### ${headerText}\n${content}`)
    totalTokens += Math.ceil((headerText.length + content.length + 10) / 4)
    sectionsUsed++

    if (totalTokens >= maxTokenBudget) break
  }

  if (parts.length === 0) return empty

  const contextText = `\n\n--- NỘI DUNG ĐẶC TẢ ĐÃ CÓ TỪ CÁC PHASE TRƯỚC (Prior Sections Context) ---\n${parts.join("\n\n")}\n--- HẾT NỘI DUNG PHASE TRƯỚC ---\n`

  return {
    contextText,
    tokenCount: totalTokens,
    sectionsUsed
  }
}
