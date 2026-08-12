export enum ActionType {
  SUMMARIZE = "summarize",
  EXTRACT = "extract",
  ANALYSIS = "analysis",
  CLARIFICATION = "clarification",
  GENERATE_SECTION = "generate_section",
  VERIFICATION = "verification",
  REWRITE = "rewrite",
  GENERATE_DIAGRAM = "generate_diagram",
  DIAGRAM_CLASSIFY = "diagram_classify",
  DIAGRAM_GENERATE = "diagram_generate",
  PRIORITY_RANKING = "priority_ranking",
  SCOPE_OUT_OF_SCOPE = "scope_out_of_scope",
  CHAT = "chat"
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
  provider: "openai" | "anthropic" | "gemini" | string
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
