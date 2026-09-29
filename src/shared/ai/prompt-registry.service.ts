import { ActionType, AiProviderConfig, SKILL_BY_ACTION_TYPE } from "./ai-action.types.js"
import {
  getPromptAssetIndex,
  getSkillIndex,
  invalidatePromptAssetCache,
  invalidateSkillCache,
  loadSkillReference,
  type OutputSchemaName,
  type SkillKind,
  type SkillLanguage
} from "./prompt-assets.js"

/**
 * Registry CHỈ đọc đĩa (Phases §8, T03). Nhánh override `PromptTemplate` trong
 * DB đã bỏ: DB rỗng hay DB cũ đều không còn đổi được prompt/provider lúc chạy.
 * Model `PromptTemplate` và `seed-from-md.ts` đã xoá ở T21.
 */

export interface LoadedPromptTemplate {
  actionType: string
  template: string
  providerConfig: AiProviderConfig
  /** Có khi template đến từ skill (ActionType pipeline). */
  skillId?: string
  asset_version?: string
}

export interface LoadedSkill {
  skillId: string
  kind: SkillKind
  version: string
  template: string
  providerConfig: AiProviderConfig
  /** Nội dung references đã yêu cầu, theo tên file (không đuôi .md). */
  references: Record<string, string>
  /** Mọi reference có sẵn — để caller chọn nạp. */
  referenceNames: string[]
  asset_version: string
  outputSchema: OutputSchemaName[]
  language: SkillLanguage
  reads: string[]
  writes: string[]
  stub: boolean
}

export interface GetSkillOptions {
  /** Tên reference cần nạp, hoặc `"all"`. Mặc định không nạp cái nào. */
  references?: string[] | "all"
}

export const getSkill = (skillId: string, options: GetSkillOptions = {}): LoadedSkill => {
  const skill = getSkillIndex().get(skillId)

  if (!skill) {
    throw new Error(
      `Không tìm thấy skill '${skillId}'. ` +
        `Tạo assets/skills/<kind>/${skillId}/SKILL.md (xem assets/skills/README.md).`
    )
  }

  const wanted = options.references === "all" ? skill.referenceNames : options.references ?? []
  const references: Record<string, string> = {}
  for (const name of wanted) {
    references[name] = loadSkillReference(skillId, name)
  }

  return {
    skillId: skill.skillId,
    kind: skill.kind,
    version: skill.version,
    template: skill.template,
    providerConfig: {
      provider: skill.provider,
      model: skill.aiModel,
      ...(skill.fallbackModels.length ? { fallbackModels: skill.fallbackModels } : {}),
      maxTokens: skill.maxTokens,
      temperature: skill.temperature
    },
    references,
    referenceNames: skill.referenceNames,
    asset_version: skill.assetVersion,
    outputSchema: skill.outputSchema,
    language: skill.language,
    reads: skill.reads,
    writes: skill.writes,
    stub: skill.stub
  }
}

/**
 * Template cho `executeAiAction`. Thứ tự: prompt phẳng `assets/prompts/<actionType>.md`
 * → skill hành động theo `SKILL_BY_ACTION_TYPE`. Không có fallback generic là CÓ CHỦ Ý:
 * asset thiếu phải là lỗi ồn ào, không phải template vô nghĩa gửi thẳng tới model.
 */
export const getPromptTemplate = async (
  actionType: ActionType | string
): Promise<LoadedPromptTemplate> => {
  const asset = getPromptAssetIndex().get(actionType)

  if (asset) {
    return {
      actionType: asset.actionType,
      template: asset.template,
      providerConfig: {
        provider: asset.provider,
        model: asset.aiModel,
        maxTokens: asset.maxTokens,
        temperature: asset.temperature
      }
    }
  }

  const skillId = SKILL_BY_ACTION_TYPE[actionType as ActionType]
  if (skillId) {
    const skill = getSkill(skillId)
    return {
      actionType,
      template: skill.template,
      providerConfig: skill.providerConfig,
      skillId,
      asset_version: skill.asset_version
    }
  }

  throw new Error(
    `Không tìm thấy prompt asset cho actionType '${actionType}'. ` +
      `Tạo assets/prompts/${actionType}.md (xem assets/prompts/README.md) ` +
      `hoặc khai skill trong SKILL_BY_ACTION_TYPE.`
  )
}

/** Xoá cache index trên đĩa. Tham số giữ cho tương thích chữ ký cũ. */
export const invalidatePromptCache = (_actionType?: string): void => {
  invalidatePromptAssetCache()
  invalidateSkillCache()
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
