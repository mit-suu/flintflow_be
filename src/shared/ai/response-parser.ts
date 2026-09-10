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

export const extractJsonFromText = (
  text: string,
  expectedType: "object" | "array" | "any" = "any"
): string => {
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

  // 2. If it still doesn't parse, try brace-matching to extract the JSON object/array
  try {
    const parsed = JSON.parse(cleaned)
    if (expectedType === "object" && Array.isArray(parsed)) {
      // Intentionally fall through to look for an outer object if an array was parsed
    } else if (expectedType === "array" && !Array.isArray(parsed)) {
      // Intentionally fall through to look for an array if an object was parsed
    } else {
      return cleaned
    }
  } catch (err) {
    // continue below
  }

  // If we expect an object or any (not explicitly array):
  if (expectedType !== "array") {
    const firstBrace = cleaned.indexOf("{")
    const lastBrace = cleaned.lastIndexOf("}")
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      const candidate = cleaned.substring(firstBrace, lastBrace + 1).trim()
      try {
        const parsed = JSON.parse(candidate)
        if (!Array.isArray(parsed)) {
          return candidate
        }
      } catch (_) {
        // Fall back to the cleaned string if parsing the candidate also fails
      }
    }
  }

  // If we expect an array or text explicitly starts with [:
  if (expectedType === "array" || (expectedType === "any" && cleaned.startsWith("["))) {
    const firstBracket = cleaned.indexOf("[")
    const lastBracket = cleaned.lastIndexOf("]")
    if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
      const candidate = cleaned.substring(firstBracket, lastBracket + 1).trim()
      try {
        const parsed = JSON.parse(candidate)
        if (Array.isArray(parsed)) {
          return candidate
        }
      } catch (_) {}
    }
  }

  return cleaned
}

/**
 * Safely extract clean conversational reply string from text that may be
 * a raw JSON or truncated JSON string, ensuring raw JSON structure is NEVER returned as the reply.
 */
export function extractCleanReplyFromRawText(rawText: string): string {
  const trimmed = rawText.trim()
  if (!trimmed) return ""

  // If it's a code block ```json ... ```, strip it
  let candidate = trimmed
  if (candidate.startsWith("```")) {
    candidate = candidate.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim()
  }

  // 1. If it parses as a JSON object, get .reply
  try {
    const obj = JSON.parse(candidate)
    if (obj && typeof obj.reply === "string") {
      // Check if obj.reply is itself JSON-stringified
      return extractCleanReplyFromRawText(obj.reply)
    }
  } catch (_) {}

  // 2. Non-greedy regex to match "reply": "..."
  const replyMatch = candidate.match(/(?:'|")reply(?:'|")\s*:\s*(['"])([\s\S]*?)(?<!\\)\1(?:\s*[,}]\s*|$)/)
  if (replyMatch && replyMatch[2] !== undefined) {
    try {
      return JSON.parse(`"${replyMatch[2]}"`)
    } catch (_) {
      return replyMatch[2]
        .replace(/\\n/g, "\n")
        .replace(/\\"/g, '"')
        .replace(/\\t/g, "\t")
        .replace(/\\\\/g, "\\")
    }
  }

  // 3. What if it was truncated IN THE MIDDLE of "reply"?
  const openReplyMatch = candidate.match(/(?:'|")reply(?:'|")\s*:\s*(['"])([\s\S]*)$/)
  if (openReplyMatch && openReplyMatch[2] !== undefined) {
    let unclosed = openReplyMatch[2]
    if (unclosed.endsWith(openReplyMatch[1])) {
      unclosed = unclosed.slice(0, -1)
    }
    return unclosed
      .replace(/\\n/g, "\n")
      .replace(/\\"/g, '"')
      .replace(/\\t/g, "\t")
      .replace(/\\\\/g, "\\")
      .trim()
  }

  // 4. If candidate does NOT start with { or [ and has no "reply":, it's already a plain text response
  if (!candidate.startsWith("{") && !candidate.startsWith("[") && !candidate.includes('"reply"')) {
    return candidate
  }

  // 5. Fallback: strip leading JSON wrapper
  const stripped = candidate
    .replace(/^\{[\s\S]*?"reply"\s*:\s*"/i, "")
    .replace(/"\s*,[\s\S]*$/, "")
    .replace(/\\n/g, "\n")
    .replace(/\\"/g, '"')
    .replace(/\\t/g, "\t")
    .replace(/\\\\/g, "\\")

  return stripped.trim() || candidate
}

/**
 * Salvage any completed question objects from text that contains "questions": [...]
 */
export function extractQuestionsFallback(text: string): Array<{
  question: string
  suggestedAnswers: string[]
  multiple?: boolean
}> {
  const questions: Array<{ question: string; suggestedAnswers: string[]; multiple?: boolean }> = []

  // Try to find individual question blocks: { "question": "...", "suggestedAnswers": [...] }
  const blockRegex = /\{\s*"question"\s*:\s*"((?:[^"\\]|\\.)*?)"[\s\S]*?\}/g
  let match: RegExpExecArray | null

  while ((match = blockRegex.exec(text)) !== null) {
    const blockStr = match[0]
    try {
      const parsed = JSON.parse(blockStr)
      if (parsed.question) {
        questions.push({
          question: parsed.question,
          suggestedAnswers: Array.isArray(parsed.suggestedAnswers) ? parsed.suggestedAnswers : [],
          multiple: Boolean(parsed.multiple)
        })
        continue
      }
    } catch (_) {}

    // Regex extraction for question & answers inside block
    const qMatch = blockStr.match(/"question"\s*:\s*"((?:[^"\\]|\\.)*?)"/)
    if (qMatch && qMatch[1]) {
      const qText = qMatch[1].replace(/\\"/g, '"').replace(/\\n/g, "\n")
      const answers: string[] = []
      const answersMatch = blockStr.match(/"suggestedAnswers"\s*:\s*\[([\s\S]*?)\]/)
      if (answersMatch && answersMatch[1]) {
        const itemRegex = /"((?:[^"\\]|\\.)*?)"/g
        let aMatch: RegExpExecArray | null
        while ((aMatch = itemRegex.exec(answersMatch[1])) !== null) {
          answers.push(aMatch[1].replace(/\\"/g, '"'))
        }
      }
      const multipleMatch = blockStr.match(/"multiple"\s*:\s*(true|false)/i)
      questions.push({
        question: qText,
        suggestedAnswers: answers,
        multiple: multipleMatch ? multipleMatch[1].toLowerCase() === "true" : false
      })
    }
  }

  return questions
}

export const parseResponse = <T = any>(
  rawText: string,
  actionType: ActionType | string
): T => {
  const expectedType = actionType === ActionType.PRIORITY_RANKING ? "array" : "object"
  const jsonText = extractJsonFromText(rawText, expectedType)

  let parsedJson: any
  try {
    parsedJson = JSON.parse(jsonText)
    // If the schema expects an object but parsedJson is an array, force fallback to raw text parsing
    if (expectedType === "object" && Array.isArray(parsedJson)) {
      throw new Error("Expected JSON object but extracted an array")
    }
  } catch (err: any) {
    // If text is not JSON and actionType allows plain string or fallback
    if (actionType === ActionType.REWRITE || actionType === ActionType.GENERATE_SECTION) {
      return { content: rawText, rewrittenContent: rawText } as unknown as T
    }

    if (actionType === ActionType.CHAT) {
      const cleanReply = extractCleanReplyFromRawText(rawText)
      const salvagedQuestions = extractQuestionsFallback(rawText)
      return { reply: cleanReply, questions: salvagedQuestions } as unknown as T
    }

    if (actionType === ActionType.CHAT_DISCOVERY) {
      const cleanReply = extractCleanReplyFromRawText(rawText)
      const salvagedQuestions = extractQuestionsFallback(rawText)

      // Try to extract evaluation if partially present
      let evaluation: any = {
        currentStep: 1,
        stepCompleteness: 50,
        isStepComplete: false,
        isDiscoveryComplete: false,
        recommendedAction: "continue_discussion"
      }
      const evalMatch = rawText.match(/"evaluation"\s*:\s*(\{[\s\S]*?\})/)
      if (evalMatch && evalMatch[1]) {
        try {
          const parsedEval = JSON.parse(evalMatch[1])
          evaluation = { ...evaluation, ...parsedEval }
        } catch (_) {}
      }

      return {
        reply: cleanReply,
        questions: salvagedQuestions,
        evaluation
      } as unknown as T
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
    // Unconditional graceful recovery for CHAT and CHAT_DISCOVERY if schema validation fails
    if (actionType === ActionType.CHAT) {
      const cleanReply = extractCleanReplyFromRawText(
        typeof parsedJson?.reply === "string" ? parsedJson.reply : rawText
      )
      const salvagedQuestions = Array.isArray(parsedJson?.questions)
        ? parsedJson.questions
        : extractQuestionsFallback(rawText)
      return {
        reply: cleanReply,
        questions: salvagedQuestions
      } as unknown as T
    }

    if (actionType === ActionType.CHAT_DISCOVERY) {
      const cleanReply = extractCleanReplyFromRawText(
        typeof parsedJson?.reply === "string" ? parsedJson.reply : rawText
      )
      const salvagedQuestions = Array.isArray(parsedJson?.questions)
        ? parsedJson.questions
        : extractQuestionsFallback(rawText)

      let evaluation: any = {
        currentStep: 1,
        stepCompleteness: 50,
        isStepComplete: false,
        isDiscoveryComplete: false,
        recommendedAction: "continue_discussion"
      }
      if (parsedJson && typeof parsedJson === "object" && !Array.isArray(parsedJson) && parsedJson.evaluation) {
        evaluation = { ...evaluation, ...parsedJson.evaluation }
      } else {
        const evalMatch = rawText.match(/"evaluation"\s*:\s*(\{[\s\S]*?\})/)
        if (evalMatch && evalMatch[1]) {
          try {
            evaluation = { ...evaluation, ...JSON.parse(evalMatch[1]) }
          } catch (_) {}
        }
      }

      return {
        reply: cleanReply,
        questions: salvagedQuestions,
        evaluation
      } as unknown as T
    }

    throw new AiActionError(
      422,
      `AI response failed Zod schema validation for action '${actionType}': ${validation.error.message}`,
      "SCHEMA_MISMATCH",
      { rawText, validationErrors: validation.error.format() }
    )
  }

  // Ensure reply is clean even on successful schema parse (guard against double-stringified reply)
  if (
    (actionType === ActionType.CHAT || actionType === ActionType.CHAT_DISCOVERY) &&
    validation.data &&
    typeof (validation.data as any).reply === "string"
  ) {
    (validation.data as any).reply = extractCleanReplyFromRawText((validation.data as any).reply)
  }

  return validation.data as T
}
