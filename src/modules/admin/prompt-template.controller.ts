import { Request, Response, NextFunction } from "express"
import { getPromptTemplate, getSkill } from "../../shared/ai/prompt-registry.service.js"
import { listPromptAssets, listSkillAssets } from "../../shared/ai/prompt-assets.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { sendSuccess } from "../../shared/types/api-response.js"

/**
 * Trang admin prompt: READ-ONLY (T03, Phases §8 — vòng một không có DB override).
 * GET trả bản trên đĩa đọc từ registry; POST/PUT/PATCH trả 410.
 */

const paramOf = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? value[0] : value ?? ""

const listDiskTemplates = () => [
  ...listPromptAssets().map((a) => ({
    source: "prompt" as const,
    actionType: a.actionType,
    file: `prompts/${a.file.replace(/\\/g, "/")}`,
    description: a.description,
    provider: a.provider,
    aiModel: a.aiModel,
    maxTokens: a.maxTokens,
    temperature: a.temperature,
    isActive: a.isActive,
    readOnly: true,
    template: a.template
  })),
  ...listSkillAssets().map((s) => ({
    source: "skill" as const,
    skillId: s.skillId,
    kind: s.kind,
    file: `skills/${s.dir}/SKILL.md`,
    description: s.description,
    version: s.version,
    asset_version: s.assetVersion,
    stub: s.stub,
    provider: s.provider,
    aiModel: s.aiModel,
    maxTokens: s.maxTokens,
    temperature: s.temperature,
    isActive: true,
    readOnly: true,
    template: s.template
  }))
]

export const listPromptTemplates = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { actionType } = req.query
    const all = listDiskTemplates()
    const filtered = actionType
      ? all.filter((t) => ("actionType" in t ? t.actionType : t.skillId) === String(actionType))
      : all

    return sendSuccess(res, 200, filtered)
  } catch (error) {
    next(error)
  }
}

/** `:actionType` nhận cả ActionType lẫn skill_id. */
const loadFromDisk = async (key: string) => {
  try {
    const loaded = await getPromptTemplate(key)
    return { source: "disk", readOnly: true, isActive: true, ...loaded }
  } catch {
    try {
      const skill = getSkill(key)
      return { source: "disk", readOnly: true, isActive: true, actionType: null, ...skill }
    } catch {
      throw new ApiError(404, `Không tìm thấy template trên đĩa cho '${key}'`, "TEMPLATE_NOT_FOUND")
    }
  }
}

export const getActivePromptTemplate = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    return sendSuccess(res, 200, await loadFromDisk(paramOf(req.params.actionType)))
  } catch (error) {
    next(error)
  }
}

/** Không còn lịch sử version trong DB — lịch sử nằm ở git. Trả bản hiện hành. */
export const getPromptTemplateHistory = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    return sendSuccess(res, 200, [await loadFromDisk(paramOf(req.params.actionType))])
  } catch (error) {
    next(error)
  }
}

const rejectOverride = (_req: Request, _res: Response, next: NextFunction) => {
  next(
    new ApiError(
      410,
      "Đã bỏ override prompt qua admin. Prompt/skill chỉ sửa trong repo (assets/skills, assets/prompts).",
      "PROMPT_OVERRIDE_DISABLED"
    )
  )
}

export const createPromptTemplate = rejectOverride
export const updatePromptTemplate = rejectOverride
export const activatePromptTemplateVersion = rejectOverride
