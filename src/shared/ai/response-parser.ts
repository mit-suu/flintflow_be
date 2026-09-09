import { z } from "zod"
import { ActionType, AiActionError } from "./ai-action.types.js"

// Schemas per ActionType
export const summarizeSchema = z.object({
  summary: z.string(),
  keyPoints: z.array(z.string()).optional()
})

export const extractSchema = z.object({
  title: z.string().optional(),
  entities: z.array(z.any()).optional(),
  attributes: z.record(z.string(), z.any()).optional(),
  requirements: z.array(z.string()).optional()
})

export const analysisSchema = z.object({
  businessGoals: z.array(z.string()).optional(),
  targetUsers: z.array(z.string()).optional(),
  risks: z.array(z.string()).optional(),
  constraints: z.array(z.string()).optional(),
  summary: z.string().optional()
})

export const clarificationSchema = z.object({
  questions: z.array(
    z.object({
      id: z.string().optional(),
      question: z.string(),
      reason: z.string().optional()
    })
  )
})

export const generateSectionSchema = z.object({
  sectionName: z.string().optional(),
  content: z.string(),
  subSections: z.array(z.any()).optional(),
  // Task 2e: sourceLinks optional — AI returns this for traceability (Task 2d)
  sourceLinks: z.array(
    z.object({
      documentId: z.string(),
      excerpt: z.string()
    })
  ).optional()
})

export const verificationSchema = z.object({
  score: z.number().optional(),
  issues: z.array(
    z.object({
      severity: z.string().optional(),
      description: z.string(),
      suggestion: z.string().optional()
    })
  ),
  overallStatus: z.string().optional()
})

export const rewriteSchema = z.object({
  rewrittenContent: z.string(),
  changesSummary: z.string().optional()
})

export const generateDiagramSchema = z.object({
  explanation: z.string().optional(),
  mermaidCode: z.string()
})

export const diagramClassifySchema = z.object({
  diagramType: z.enum(["flowchart", "architecture", "sequence-timeline", "hierarchy"]),
  depth: z.enum(["simple", "comprehensive"]),
  layoutDirection: z.enum(["TD", "LR", "radial"]),
  planSummary: z.string(),
  elements: z.array(z.string()).optional(),
  colorMapping: z.record(z.string(), z.string()).optional()
})

export const diagramGenerateSchema = z.object({
  explanation: z.string().optional(),
  excalidrawElements: z.array(z.any()),
  appState: z.object({
    viewBackgroundColor: z.string().optional(),
    gridSize: z.number().optional()
  }).optional()
})

export const priorityRankingSchema = z.array(
  z.object({
    id: z.string(),
    module: z.string(),
    featureName: z.string(),
    description: z.string(),
    verificationCondition: z.string().optional(),
    priority: z.enum(["Must-have", "Should-have", "Could-have", "Won't-have"]),
    priorityReason: z.string(),
    source: z.string().optional()
  })
)

export const scopeOutOfScopeSchema = z.object({
  content: z.string()
})

export const chatQuestionSchema = z.object({
  question: z.string(),
  suggestedAnswers: z.array(z.string()).default([]),
  multiple: z.boolean().optional().default(false),
})

export const chatQuestionItemSchema = z.union([
  chatQuestionSchema,
  z.string().transform((q) => ({ question: q, suggestedAnswers: [], multiple: false }))
])

export const chatSchema = z.object({
  reply: z.string(),
  questions: z.array(chatQuestionItemSchema).optional().default([]),
  suggestedQuestions: z.array(z.string()).optional()
})

// ─── Discovery Chat Evaluation Schema ───
export const chatDiscoveryEvaluationSchema = z.object({
  currentStep: z.number().min(1).max(6),
  stepCompleteness: z.number().min(0).max(100),
  isStepComplete: z.boolean(),
  isDiscoveryComplete: z.boolean(),
  recommendedAction: z.enum([
    "ask_clarification",
    "propose_next_step",
    "show_summary",
    "continue_discussion"
  ]),
  stepSummary: z.string().optional(),
  missingInfo: z.array(z.string()).optional()
})

export const chatDiscoverySchema = z.object({
  reply: z.string(),
  questions: z.array(chatQuestionItemSchema).optional().default([]),
  suggestedQuestions: z.array(z.string()).optional(),
  evaluation: chatDiscoveryEvaluationSchema
})

// Task 2b: schema cho action SUMMARIZE_DOCUMENT
export const summarizeDocumentSchema = z.object({
  summary: z.string(),
  keyThemes: z.array(z.string()).optional()
})

const SCHEMAS: Record<string, z.ZodSchema> = {
  [ActionType.SUMMARIZE]: summarizeSchema,
  [ActionType.EXTRACT]: extractSchema,
  [ActionType.ANALYSIS]: analysisSchema,
  [ActionType.CLARIFICATION]: clarificationSchema,
  [ActionType.GENERATE_SECTION]: generateSectionSchema,
  [ActionType.VERIFICATION]: verificationSchema,
  [ActionType.REWRITE]: rewriteSchema,
  [ActionType.GENERATE_DIAGRAM]: generateDiagramSchema,
  [ActionType.DIAGRAM_CLASSIFY]: diagramClassifySchema,
  [ActionType.DIAGRAM_GENERATE]: diagramGenerateSchema,
  [ActionType.PRIORITY_RANKING]: priorityRankingSchema,
  [ActionType.SCOPE_OUT_OF_SCOPE]: scopeOutOfScopeSchema,
  [ActionType.CHAT]: chatSchema,
  [ActionType.CHAT_DISCOVERY]: chatDiscoverySchema,
  [ActionType.SUMMARIZE_DOCUMENT]: summarizeDocumentSchema
}

export const extractJsonFromText = (text: string): string => {
  let cleaned = text.trim()

  // 1. Try to clean standard or unclosed code fences
  if (cleaned.startsWith("```")) {
    const firstNewline = cleaned.indexOf("\n")
    if (firstNewline !== -1) {
      const lastFence = cleaned.lastIndexOf("```")
      if (lastFence > firstNewline) {
        // Closed code fence
        cleaned = cleaned.substring(firstNewline + 1, lastFence).trim()
      } else {
        // Unclosed code fence (truncated or model output issue)
        cleaned = cleaned.substring(firstNewline + 1).trim()
      }
    }
  }

  // 2. If it still doesn't parse, try brace-matching to extract the JSON object
  try {
    JSON.parse(cleaned)
    return cleaned
  } catch (err) {
    const firstBrace = cleaned.indexOf("{")
    const lastBrace = cleaned.lastIndexOf("}")
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      const candidate = cleaned.substring(firstBrace, lastBrace + 1).trim()
      try {
        JSON.parse(candidate)
        return candidate
      } catch (_) {
        // Fall back to the cleaned string if parsing the candidate also fails
      }
    }

    const firstBracket = cleaned.indexOf("[")
    const lastBracket = cleaned.lastIndexOf("]")
    if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
      const candidate = cleaned.substring(firstBracket, lastBracket + 1).trim()
      try {
        JSON.parse(candidate)
        return candidate
      } catch (_) {}
    }
  }

  return cleaned
}

export const parseResponse = <T = any>(
  rawText: string,
  actionType: ActionType | string
): T => {
  const jsonText = extractJsonFromText(rawText)

  let parsedJson: any
  try {
    parsedJson = JSON.parse(jsonText)
  } catch (err: any) {
    // If text is not JSON and actionType allows plain string or fallback
    if (actionType === ActionType.REWRITE || actionType === ActionType.GENERATE_SECTION) {
      return { content: rawText, rewrittenContent: rawText } as unknown as T
    }
    
    if (actionType === ActionType.PRIORITY_RANKING) {
      throw new AiActionError(
        422,
        `AI response is not a valid JSON array for action '${actionType}': ${err.message}`,
        "PARSE_FAILED",
        { rawText }
      )
    }

    throw new AiActionError(
      422,
      `AI response is not valid JSON for action '${actionType}': ${err.message}`,
      "PARSE_FAILED",
      { rawText }
    )
  }

  const schema = SCHEMAS[actionType]
  if (!schema) {
    return parsedJson as T
  }

  const validation = schema.safeParse(parsedJson)
  if (!validation.success) {
    throw new AiActionError(
      422,
      `AI response failed Zod schema validation for action '${actionType}': ${validation.error.message}`,
      "SCHEMA_MISMATCH",
      { rawText, validationErrors: validation.error.format() }
    )
  }

  return validation.data as T
}
