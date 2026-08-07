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
    template: `Viết đặc tả chi tiết cho phần {{section_name}} dựa trên ngữ cảnh dự án sau:\n\n{{context}}`,
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
