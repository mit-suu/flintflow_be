import { PromptTemplate } from "../../modules/admin/prompt-template.model.js"
import { ActionType, AiProviderConfig } from "./ai-action.types.js"
import { getPromptAssetIndex } from "./prompt-assets.js"

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
    console.warn(`[PromptRegistry] Query DB that bai cho '${actionType}', doc asset tren dia.`, error)
  }

  // Không có override trong DB ⇒ đọc asset trên ĐĨA (nguồn sự thật theo §8).
  //
  // Không có fallback generic ở đây là CÓ CHỦ Ý: một prompt asset thiếu phải là
  // lỗi ồn ào, không phải một template vô nghĩa gửi thẳng tới model rồi thất bại
  // ở tầng parse với thông báo không liên quan.
  const asset = getPromptAssetIndex().get(actionType)

  if (!asset) {
    throw new Error(
      `Không tìm thấy prompt asset cho actionType '${actionType}'. ` +
        `Tạo file assets/prompts/${actionType}.md (xem assets/prompts/README.md), ` +
        `hoặc seed override vào DB bằng "npm run seed:md".`
    )
  }

  const loaded: LoadedPromptTemplate = {
    actionType: asset.actionType,
    template: asset.template,
    providerConfig: {
      provider: asset.provider,
      model: asset.aiModel,
      maxTokens: asset.maxTokens,
      temperature: asset.temperature
    }
  }

  templateCache.set(actionType, { data: loaded, cachedAt: now })
  return loaded
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
