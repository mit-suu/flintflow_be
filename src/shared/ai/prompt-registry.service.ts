import { PromptTemplate } from "../../modules/admin/prompt-template.model.js"
import { ActionType, AiProviderConfig } from "./ai-action.types.js"

export interface LoadedPromptTemplate {
  actionType: string
  template: string
  providerConfig: AiProviderConfig
}

interface CacheEntry {
  data: LoadedPromptTemplate
  cachedAt: number
}

const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes
const templateCache = new Map<string, CacheEntry>()

const DEFAULT_TEMPLATES: Record<string, LoadedPromptTemplate> = {
  [ActionType.SUMMARIZE]: {
    actionType: ActionType.SUMMARIZE,
    template: `Tóm tắt nội dung sau đây một cách ngắn gọn, súc tích:\n\n{{input_text}}`,
    providerConfig: { provider: "openai", model: "gpt-4o-mini", maxTokens: 1024, temperature: 0.5 }
  },
  [ActionType.EXTRACT]: {
    actionType: ActionType.EXTRACT,
    template: `Trích xuất các thông tin chính, yêu cầu và đối tượng sử dụng từ văn bản sau dưới dạng cấu trúc JSON:\n\n{{input_text}}`,
    providerConfig: { provider: "openai", model: "gpt-4o-mini", maxTokens: 2048, temperature: 0.3 }
  },
  [ActionType.ANALYSIS]: {
    actionType: ActionType.ANALYSIS,
    template: `Phân tích yêu cầu phần mềm sau về mục tiêu kinh doanh, người dùng chính, ràng buộc kỹ thuật và rủi ro:\n\n{{input_text}}`,
    providerConfig: { provider: "openai", model: "gpt-4o-mini", maxTokens: 2048, temperature: 0.5 }
  },
  [ActionType.CLARIFICATION]: {
    actionType: ActionType.CLARIFICATION,
    template: `Đưa ra danh sách các câu hỏi làm rõ đúng trọng tâm để làm sáng tỏ ý tưởng/yêu cầu phần mềm sau:\n\n{{input_text}}`,
    providerConfig: { provider: "openai", model: "gpt-4o-mini", maxTokens: 2048, temperature: 0.7 }
  },
  [ActionType.GENERATE_SECTION]: {
    actionType: ActionType.GENERATE_SECTION,
    template: `You are a Senior Business Analyst writing a Software Requirements Specification (SRS) document.
Your task is to write the "{{section_name}}" section.

{{documentContext}}
(If the section above is empty, no source documents were provided — generate based on the conversation context only. Do not mention missing documents to the user.)

Conversation context from the requirements interview:
{{context}}

Instructions:
- Write comprehensive, professional SRS content for "{{section_name}}".
- If source documents were provided above, cite relevant information and indicate which document it came from.
- Return a valid JSON object with this exact structure:
{
  "content": "<full section content in Markdown>",
  "sourceLinks": [
    { "documentId": "<exact documentId from source label>", "excerpt": "<exact short quote from the document that was used>" }
  ]
}
- The sourceLinks array should only contain entries where you directly used content from a source document. Omit entries for inferred or synthesized content.
- If no source documents were provided or used, return sourceLinks as an empty array [].`,
    providerConfig: { provider: "openai", model: "gpt-4o-mini", maxTokens: 3000, temperature: 0.7 }
  },
  [ActionType.VERIFICATION]: {
    actionType: ActionType.VERIFICATION,
    template: `Kiểm tra rà soát khoảng trống, điểm mâu thuẫn và mức độ hoàn thiện của tài liệu đặc tả sau:\n\n{{specification}}`,
    providerConfig: { provider: "openai", model: "gpt-4o-mini", maxTokens: 2048, temperature: 0.3 }
  },
  [ActionType.REWRITE]: {
    actionType: ActionType.REWRITE,
    template: `Viết lại nội dung sau cho mạch lạc, chuẩn mực đặc tả phần mềm hơn:\n\n{{content}}`,
    providerConfig: { provider: "openai", model: "gpt-4o-mini", maxTokens: 2048, temperature: 0.5 }
  },
  [ActionType.PRIORITY_RANKING]: {
    actionType: ActionType.PRIORITY_RANKING,
    template: `You are an Expert Product Manager. Evaluate the provided list of software functional requirements. Categorize them using the MoSCoW prioritization method (Must-have, Should-have, Could-have, Won't-have) strictly based on the provided project context. You must return ONLY a valid JSON array of objects matching the exact structure of the input, but with 'priority' and 'priorityReason' fields filled in. No markdown wrapping, no extra text.\n\nProject Context:\n{{project_context}}\n\nRequirements to prioritize:\n{{functional_requirements}}`,
    providerConfig: { provider: "anthropic", model: "claude-haiku-4-5-20251001", maxTokens: 4096, temperature: 0.3 }
  },
  [ActionType.SCOPE_OUT_OF_SCOPE]: {
    actionType: ActionType.SCOPE_OUT_OF_SCOPE,
    template: `You are a Senior Business Analyst writing a Software Requirement Specification (SRS) document. Based on the categorized MoSCoW feature lists, write the 'Scope' and 'Out-of-Scope' sections in professional Markdown format. Do not use JSON. Return your response as a JSON object with a single key "content" containing the Markdown text.\n\nProject Context:\n{{project_context}}\n\nIn-Scope Features (Must-have, Should-have, Could-have):\n{{in_scope_features}}\n\nExcluded Features (Won't have):\n{{out_scope_features}}\n\nTask:\n1. Write a brief introductory paragraph defining the boundary of the MVP.\n2. List the In-Scope functional modules logically.\n3. List the Out-of-Scope items logically (must include all 'Won't have' features and deduce 2-3 logical technical boundaries like 'No mobile app', 'No 3D rendering' based on context to prevent scope creep).`,
    providerConfig: { provider: "anthropic", model: "claude-haiku-4-5-20251001", maxTokens: 3000, temperature: 0.7 }
  },
  // Task 2e: CHAT default template — hỗ trợ {{documentContext}} từ Task 2c
  [ActionType.CHAT]: {
    actionType: ActionType.CHAT,
    template: `You are a professional Business Analyst (BA) conducting a requirements discovery interview.
You are helping clarify the "{{step_name}}" section of a Software Requirements Specification (SRS).

{{documentContext}}
(If the section above is empty, no source documents were attached — rely on the conversation only. Do not mention missing documents.)

Conversation history:
{{chat_history}}

User's latest message:
{{input_text}}

Instructions:
- Respond as a friendly but precise BA. Ask focused follow-up questions to clarify ambiguities.
- If source documents were provided, reference them when relevant to ground your questions in real requirements.
- Keep your reply concise (2-4 sentences max) unless the user asks for detail.
- Return ONLY a valid JSON object (no markdown wrapper):
{
  "reply": "<your response here>",
  "suggestedQuestions": ["<follow-up 1>", "<follow-up 2>", "<follow-up 3>"]
}`,
    providerConfig: { provider: "openai", model: "gpt-4o-mini", maxTokens: 1024, temperature: 0.7 }
  },
  // Task 2b: Summarize uploaded document — chạy 1 lần sau parse, lưu vào ProjectDocument.summary
  [ActionType.SUMMARIZE_DOCUMENT]: {
    actionType: ActionType.SUMMARIZE_DOCUMENT,
    template: `You are a Business Analyst assistant. Summarize the following document content for use in a Software Requirements Specification (SRS) process.

Rules:
- Output length should be 15-20% of the original length.
- Preserve ALL business requirements, functional constraints, numeric values, deadlines, and stakeholder names.
- Omit filler text, repeated sections, and formatting noise.
- Write in clear, formal English.
- Return ONLY a valid JSON object with this exact structure (no markdown, no extra text):
{
  "summary": "<condensed content here>",
  "keyThemes": ["<theme 1>", "<theme 2>", ...]
}

Document content:
{{document_text}}`,
    providerConfig: { provider: "openai", model: "gpt-4o-mini", maxTokens: 2048, temperature: 0.3 }
  }
}

export const getPromptTemplate = async (
  actionType: ActionType | string
): Promise<LoadedPromptTemplate> => {
  const cached = templateCache.get(actionType)
  const now = Date.now()

  if (cached && now - cached.cachedAt < CACHE_TTL_MS) {
    return cached.data
  }

  try {
    const dbTemplate = await PromptTemplate.findOne({ actionType, isActive: true })

    if (dbTemplate) {
      const loaded: LoadedPromptTemplate = {
        actionType: dbTemplate.actionType,
        template: dbTemplate.template,
        providerConfig: {
          provider: dbTemplate.provider || "openai",
          model: dbTemplate.aiModel || "gpt-4o-mini",
          maxTokens: dbTemplate.maxTokens || 2048,
          temperature: dbTemplate.temperature ?? 0.7
        }
      }

      templateCache.set(actionType, { data: loaded, cachedAt: now })
      return loaded
    }
  } catch (error) {
    console.warn(`[PromptRegistry] Failed to query PromptTemplate from DB for '${actionType}', using fallback.`, error)
  }

  // Fallback default template
  const fallback = DEFAULT_TEMPLATES[actionType] || {
    actionType,
    template: `Xử lý yêu cầu sau đây:\n\n{{input_text}}`,
    providerConfig: { provider: "openai", model: "gpt-4o-mini", maxTokens: 2048, temperature: 0.7 }
  }

  templateCache.set(actionType, { data: fallback, cachedAt: now })
  return fallback
}

export const invalidatePromptCache = (actionType?: string): void => {
  if (actionType) {
    templateCache.delete(actionType)
  } else {
    templateCache.clear()
  }
}

export const interpolatePrompt = (
  template: string,
  variables: Record<string, any> = {}
): string => {
  let result = template

  for (const [key, value] of Object.entries(variables)) {
    const placeholder = new RegExp(`{{\\s*${key}\\s*}}`, "g")
    const strValue = typeof value === "object" ? JSON.stringify(value, null, 2) : String(value ?? "")
    result = result.replace(placeholder, strValue)
  }

  return result
}
