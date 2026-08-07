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
  subSections: z.array(z.any()).optional()
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

export const chatSchema = z.object({
  reply: z.string(),
  suggestedQuestions: z.array(z.string()).optional()
})

const SCHEMAS: Record<string, z.ZodSchema> = {
  [ActionType.SUMMARIZE]: summarizeSchema,
  [ActionType.EXTRACT]: extractSchema,
  [ActionType.ANALYSIS]: analysisSchema,
  [ActionType.CLARIFICATION]: clarificationSchema,
  [ActionType.GENERATE_SECTION]: generateSectionSchema,
  [ActionType.VERIFICATION]: verificationSchema,
  [ActionType.REWRITE]: rewriteSchema,
  [ActionType.CHAT]: chatSchema
}

export const extractJsonFromText = (text: string): string => {
  let cleaned = text.trim()

  // Remove markdown code fences ```json ... ```
  if (cleaned.includes("```")) {
    const match = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
    if (match && match[1]) {
      cleaned = match[1].trim()
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
