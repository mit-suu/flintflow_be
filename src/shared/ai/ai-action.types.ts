/**
 * ActionType = `call_kind` của một lượt gọi model (srs-spine.md §2 `usage[].call_kind`).
 * Bảng giá ở credit-reservation.service.ts, schema đầu ra ở response-parser.ts.
 * Tên giá trị là hợp đồng với T11/T13 — đổi phải qua PR contract-change.
 */
export enum ActionType {
  // ─── Khung hành động pipeline (Phases §3) ───
  ELICIT = "elicit",
  DRAFT = "draft",
  RENDER_FIX = "render_fix",
  REVIEW = "review",
  REGENERATE = "regenerate",
  REVISION = "revision",
  DISCOVERY_STEP = "discovery_step",
  CONSISTENCY_PASS = "consistency_pass",
  GLOSSARY_SCAN = "glossary_scan",
  RECONCILE = "reconcile",
  CHANGE_INSTRUCTION = "change_instruction",

  // ─── Ngoài pipeline, còn dùng ───
  CHAT = "chat",
  SUMMARIZE_DOCUMENT = "summarize_document",

  // ─── Mode 1: import SRS có sẵn + change request (FLF-171, plan mode 1 §5.7) ───
  /** I-4 (nút 1.8): trích field Spine từ text block của một section (hoặc lô section nhỏ). */
  IMPORT_EXTRACT_FIELDS = "import_extract_fields",
  /** I-4 phần ảnh (mode 1 v3 phase 5): đọc một ảnh diagram của section (Gemini vision) ⇒ loại diagram + thực thể. */
  IMPORT_EXTRACT_DIAGRAM = "import_extract_diagram",
  /** Nút 1.11: kiểm ngữ nghĩa tài liệu vừa import — chỉ ra cờ vàng. */
  IMPORT_SEMANTIC_CHECK = "import_semantic_check",
  /** C-2 (nút 3.2): làm rõ CR, trả câu hỏi hoặc đích (entity path, từ khoá) cho C-3. */
  CR_CLARIFY = "cr_clarify",
  /** C-4 (nút 3.6): kết luận edit | comment | not_related cho từng vị trí + đề xuất text/op. */
  CR_PROPOSE = "cr_propose",
  /** C-5 (nút 3.8): kiểm nhất quán trên phạm vi thay đổi — chỉ ra cờ vàng. */
  CR_CONSISTENCY = "cr_consistency"
}

/**
 * Skill hành động (assets/skills/action/) khung một lượt gọi theo ActionType.
 * Skill nội dung/renderer của step do step runner (T13) chọn và ghép thêm.
 * ActionType không có ở đây (CHAT, SUMMARIZE_DOCUMENT) đọc prompt phẳng assets/prompts/<actionType>.md.
 */
export const SKILL_BY_ACTION_TYPE: Readonly<Partial<Record<ActionType, string>>> = {
  [ActionType.ELICIT]: "elicit-loop",
  [ActionType.DISCOVERY_STEP]: "elicit-loop",
  [ActionType.DRAFT]: "draft-to-ops",
  [ActionType.REGENERATE]: "draft-to-ops",
  [ActionType.REVISION]: "draft-to-ops",
  [ActionType.GLOSSARY_SCAN]: "draft-to-ops",
  [ActionType.RENDER_FIX]: "plantuml-conventions",
  [ActionType.REVIEW]: "review-section",
  [ActionType.CONSISTENCY_PASS]: "review-section",
  [ActionType.RECONCILE]: "apply-change-op",
  [ActionType.CHANGE_INSTRUCTION]: "apply-change-op",
  [ActionType.IMPORT_EXTRACT_FIELDS]: "import-extract",
  [ActionType.IMPORT_EXTRACT_DIAGRAM]: "import-extract-diagram",
  [ActionType.IMPORT_SEMANTIC_CHECK]: "import-semantic-check",
  [ActionType.CR_CLARIFY]: "cr-clarify",
  [ActionType.CR_PROPOSE]: "cr-propose",
  [ActionType.CR_CONSISTENCY]: "cr-consistency"
}

export interface AiActionInput {
  promptVariables?: Record<string, any>
  rawPrompt?: string
  systemInstruction?: string
  [key: string]: any
}

export interface AiActionResult<T = any> {
  success: boolean
  data: T
  rawText: string
  actionType: ActionType
  provider: string
  aiModel: string
  tokensUsed: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
  latencyMs: number
  logId: string
  cost: number
}

export interface AiProviderConfig {
  provider: "openai" | "anthropic" | "gemini" | "glm" | "modal" | "mock" | string
  model: string
  maxTokens?: number
  temperature?: number
  /** `call_kind` của lượt gọi. Provider thật bỏ qua; `mock` dùng nó để trả đúng schema đầu ra (T24). */
  actionType?: string
}

export class AiActionError extends Error {
  statusCode: number
  code: string
  details?: any

  constructor(statusCode: number, message: string, code: string, details?: any) {
    super(message)
    this.name = "AiActionError"
    this.statusCode = statusCode
    this.code = code
    this.details = details
  }
}
