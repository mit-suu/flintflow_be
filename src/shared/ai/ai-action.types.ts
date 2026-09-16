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
  SUMMARIZE_DOCUMENT = "summarize_document"
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
  [ActionType.CHANGE_INSTRUCTION]: "apply-change-op"
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
  provider: "openai" | "anthropic" | "gemini" | "glm" | "modal" | string
  model: string
  maxTokens?: number
  temperature?: number
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
