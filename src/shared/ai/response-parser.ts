import { z } from "zod"
import { ActionType, AiActionError } from "./ai-action.types.js"

// Schemas per ActionType
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

// Task 2b: schema cho action SUMMARIZE_DOCUMENT
export const summarizeDocumentSchema = z.object({
  summary: z.string(),
  keyThemes: z.array(z.string()).optional()
})

// ─── Pipeline (T03): hợp đồng đầu ra cho T08/T11 ───────────────────
// Model chỉ phát op; code áp op (Phases §2.1). Parse/validate thất bại thì
// throw — không bao giờ ghi raw text vào Spine.

export const opSchema = z.object({
  op: z.enum(["set", "add", "remove", "renumber"]),
  /** Path phân giải qua khoá, không qua chỉ số: `actors[id=A03].name` (srs-spine §1). */
  path: z.string().min(1),
  value: z.unknown().optional(),
  reason: z.string().optional()
})

export const opTransactionSchema = z.object({
  txn: z.string().optional(),
  ops: z.array(opSchema),
  notes: z.string().optional()
})

/**
 * Câu hỏi của vòng Elicit. `topic_key` (FLF-208 · R4) là khoá chủ đề để sổ quyết định chặn hỏi lặp;
 * `conflict` là lời giải thích khi model CỐ Ý hỏi lại một chủ đề đã chốt (dữ liệu mới mâu thuẫn).
 */
export const elicitQuestionSchema = z.union([
  chatQuestionSchema.extend({ topic_key: z.string().optional(), conflict: z.string().optional() }),
  z.string().transform((q) => ({ question: q, suggestedAnswers: [] as string[], multiple: false }))
])

export const elicitSchema = z.object({
  reply: z.string(),
  questions: z.array(elicitQuestionSchema).default([])
})

/** B-0…B-2: vừa hỏi vừa ghi ngay (addendum, project.*) — ops tuỳ chọn. */
export const discoveryStepSchema = elicitSchema.extend({
  ops: z.array(opSchema).optional()
})

export const reviewFlagSchema = z.object({
  level: z.enum(["red", "yellow"]),
  rule_id: z.string().optional(),
  /** Khoá logic section: `fixed:3.1.3`, `feature:F2`, `function:FN07`. */
  section_id: z.string().min(1),
  message: z.string().min(1)
})

export const reviewSchema = z.object({
  flags: z.array(reviewFlagSchema)
})

export const changeInstructionSchema = z
  .object({
    clarification_needed: z.string().optional(),
    txn: z.string().optional(),
    ops: z.array(opSchema).optional(),
    notes: z.string().optional()
  })
  .refine((v) => Boolean(v.clarification_needed) || (v.ops?.length ?? 0) > 0, {
    message: "Cần clarification_needed hoặc ít nhất một op"
  })

export const renderFixSchema = z.object({
  puml: z.string().min(1),
  notes: z.string().optional()
})

// ─── Mode 1 (FLF-171, plan mode 1 §5.7) ──────────────────────────
// Model chỉ trả JSON theo các schema dưới; code dựng op / ghi Track Changes. Parse lỗi ⇒ retry, không ghi raw.

/** Tập Spine trích được từ tài liệu import (không gồm mảng hệ thống: steps, flags, diagrams, baselines…). */
export const IMPORT_EXTRACT_ENTITIES = [
  "project",
  "actors",
  "roles",
  "use_cases",
  "features",
  "screens",
  "permissions",
  "entities",
  "functions",
  "nfrs",
  "business_rules",
  "common_requirements",
  "messages",
  "other_requirements",
  "glossary"
] as const

const blockIdRef = z.string().regex(/^B\d{4,}$/)
const confidence = z.number().min(0).max(1)

/**
 * I-4 — trích theo THỰC THỂ, không theo từng path: spike P0 đo output dạng path/value phình 0,4–3× input
 * (report §4.8). Mỗi item là một phần tử (hoặc phần `project`) kèm độ tin tổng và độ tin từng field nếu thấp.
 */
export const importExtractSchema = z.object({
  section_id: z.string().min(1),
  items: z.array(
    z.object({
      entity: z.enum(IMPORT_EXTRACT_ENTITIES),
      /** Khoá phần tử như trong tài liệu (`UC-01`, `FR-3.2`); `null` với `project` hoặc khi tài liệu không đặt mã. */
      key: z.string().min(1).nullable(),
      value: z.record(z.string(), z.unknown()),
      confidence,
      /** Chỉ liệt kê field có độ tin khác `confidence` của item (thường là field đoán). */
      field_confidence: z.record(z.string(), confidence).default({}),
      source_block_ids: z.array(blockIdRef).min(1)
    })
  ),
  /** Block trong section không trích được gì (văn xuôi giới thiệu, ghi chú) — đưa vào gap report nếu cần. */
  unmapped_block_ids: z.array(blockIdRef).default([])
})

/** Loại diagram mà I-4 đọc được từ ảnh (mode 1 v3 phase 5); `other` ⇒ không đọc, giữ ảnh gốc. */
export const DIAGRAM_IMAGE_KINDS = ["usecase", "erd", "screen_flow", "context", "other"] as const
export type DiagramImageKind = (typeof DIAGRAM_IMAGE_KINDS)[number]

/** I-4 phần ảnh: cùng hình item với `importExtract` + loại diagram. `other` thì `items` rỗng. */
export const importExtractDiagramSchema = importExtractSchema.extend({
  diagram_kind: z.enum(DIAGRAM_IMAGE_KINDS)
})

/** Nút 1.11 (IMPORT_SEMANTIC_CHECK) và 3.8 (CR_CONSISTENCY): chỉ cờ vàng — không có trường level. */
export const findingsSchema = z.object({
  findings: z
    .array(
      z.object({
        rule: z.string().min(1),
        section_id: z.string().min(1),
        message: z.string().min(1),
        block_ids: z.array(blockIdRef).default([])
      })
    )
    .max(30)
})

/** C-2: mơ hồ ⇒ có câu hỏi (≤ 5); rõ ⇒ có đích để C-3 tìm vị trí. */
export const crClarifySchema = z
  .object({
    ambiguous: z.boolean(),
    questions: z.array(z.string().min(1)).max(5).default([]),
    targets: z.object({
      entity_paths: z.array(z.string().min(1)).default([]),
      keywords: z.array(z.string().min(1)).default([])
    })
  })
  .refine((v) => !v.ambiguous || v.questions.length > 0, { message: "ambiguous = true cần ít nhất một câu hỏi" })
  .refine((v) => v.ambiguous || v.targets.entity_paths.length + v.targets.keywords.length > 0, {
    message: "ambiguous = false cần ít nhất một entity_path hoặc keyword"
  })

/**
 * C-4: mọi vị trí được giao phải có kết luận + lý do; edit cần `spine_ops` (mode 1 v2 — FLF-186: vị trí là phần tử
 * Spine, tài liệu render lại từ Spine), comment cần comment_text. `new_text` cũ còn nhận nhưng bỏ qua.
 */
export const crProposeSchema = z.object({
  locations: z.array(
    z
      .object({
        location_id: z.string().regex(/^L\d{3,}$/),
        conclusion: z.enum(["edit", "comment", "not_related"]),
        reason: z.string().min(1),
        new_text: z.string().optional(),
        comment_text: z.string().min(1).optional(),
        spine_ops: z.array(opSchema).default([])
      })
      .refine((l) => l.conclusion !== "edit" || l.spine_ops.length > 0, { message: "edit cần spine_ops" })
      .refine((l) => l.conclusion !== "comment" || l.comment_text !== undefined, { message: "comment cần comment_text" })
      .refine((l) => l.conclusion !== "not_related" || l.spine_ops.length === 0, { message: "not_related không được kèm op" })
  )
})

export type ImportExtractOutput = z.infer<typeof importExtractSchema>
export type ImportExtractDiagramOutput = z.infer<typeof importExtractDiagramSchema>
export type FindingsOutput = z.infer<typeof findingsSchema>
export type CrClarifyOutput = z.infer<typeof crClarifySchema>
export type CrProposeOutput = z.infer<typeof crProposeSchema>

export type SpineOp = z.infer<typeof opSchema>
export type OpTransaction = z.infer<typeof opTransactionSchema>
export type ElicitOutput = z.infer<typeof elicitSchema>
export type DiscoveryStepOutput = z.infer<typeof discoveryStepSchema>
export type ReviewFlag = z.infer<typeof reviewFlagSchema>
export type ReviewOutput = z.infer<typeof reviewSchema>
export type ChangeInstructionOutput = z.infer<typeof changeInstructionSchema>
export type RenderFixOutput = z.infer<typeof renderFixSchema>

/** Tên schema dùng trong frontmatter `output_schema` của skill (assets/skills/README.md). */
export const OUTPUT_SCHEMA_BY_ACTION_TYPE: Readonly<Partial<Record<ActionType, string>>> = {
  [ActionType.ELICIT]: "elicit",
  [ActionType.DISCOVERY_STEP]: "discoveryStep",
  [ActionType.DRAFT]: "opTransaction",
  [ActionType.REGENERATE]: "opTransaction",
  [ActionType.REVISION]: "opTransaction",
  [ActionType.GLOSSARY_SCAN]: "opTransaction",
  [ActionType.RECONCILE]: "opTransaction",
  [ActionType.REVIEW]: "review",
  [ActionType.CONSISTENCY_PASS]: "review",
  [ActionType.CHANGE_INSTRUCTION]: "changeInstruction",
  [ActionType.RENDER_FIX]: "renderFix",
  [ActionType.IMPORT_EXTRACT_FIELDS]: "importExtract",
  [ActionType.IMPORT_EXTRACT_DIAGRAM]: "importExtractDiagram",
  [ActionType.IMPORT_SEMANTIC_CHECK]: "findings",
  [ActionType.CR_CLARIFY]: "crClarify",
  [ActionType.CR_PROPOSE]: "crPropose",
  [ActionType.CR_CONSISTENCY]: "findings"
}

const SCHEMAS: Record<string, z.ZodSchema> = {
  [ActionType.ELICIT]: elicitSchema,
  [ActionType.DISCOVERY_STEP]: discoveryStepSchema,
  [ActionType.DRAFT]: opTransactionSchema,
  [ActionType.REGENERATE]: opTransactionSchema,
  [ActionType.REVISION]: opTransactionSchema,
  [ActionType.GLOSSARY_SCAN]: opTransactionSchema,
  [ActionType.RECONCILE]: opTransactionSchema,
  [ActionType.REVIEW]: reviewSchema,
  [ActionType.CONSISTENCY_PASS]: reviewSchema,
  [ActionType.CHANGE_INSTRUCTION]: changeInstructionSchema,
  [ActionType.RENDER_FIX]: renderFixSchema,
  [ActionType.CHAT]: chatSchema,
  [ActionType.SUMMARIZE_DOCUMENT]: summarizeDocumentSchema,
  [ActionType.IMPORT_EXTRACT_FIELDS]: importExtractSchema,
  [ActionType.IMPORT_EXTRACT_DIAGRAM]: importExtractDiagramSchema,
  [ActionType.IMPORT_SEMANTIC_CHECK]: findingsSchema,
  [ActionType.CR_CLARIFY]: crClarifySchema,
  [ActionType.CR_PROPOSE]: crProposeSchema,
  [ActionType.CR_CONSISTENCY]: findingsSchema
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
  const expectedType = "object"
  const jsonText = extractJsonFromText(rawText, expectedType)

  let parsedJson: any
  try {
    parsedJson = JSON.parse(jsonText)
    // If the schema expects an object but parsedJson is an array, force fallback to raw text parsing
    if (Array.isArray(parsedJson)) {
      throw new Error("Expected JSON object but extracted an array")
    }
  } catch (err: any) {
    // If text is not JSON and actionType allows plain string or fallback
    if (actionType === ActionType.CHAT) {
      const cleanReply = extractCleanReplyFromRawText(rawText)
      const salvagedQuestions = extractQuestionsFallback(rawText)
      return { reply: cleanReply, questions: salvagedQuestions } as unknown as T
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
    // Unconditional graceful recovery for CHAT if schema validation fails
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

    throw new AiActionError(
      422,
      `AI response failed Zod schema validation for action '${actionType}': ${validation.error.message}`,
      "SCHEMA_MISMATCH",
      { rawText, validationErrors: validation.error.format() }
    )
  }

  // Ensure reply is clean even on successful schema parse (guard against double-stringified reply)
  if (
    actionType === ActionType.CHAT &&
    validation.data &&
    typeof (validation.data as any).reply === "string"
  ) {
    (validation.data as any).reply = extractCleanReplyFromRawText((validation.data as any).reply)
  }

  return validation.data as T
}
