import { Request, Response, NextFunction } from "express"
import mongoose from "mongoose"
import { PromptTemplate } from "./prompt-template.model.js"
import { ActionType } from "../../shared/ai/ai-action.types.js"
import { invalidatePromptCache } from "../../shared/ai/prompt-registry.service.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { sendSuccess } from "../../shared/types/api-response.js"

const VALID_ACTION_TYPES = Object.values(ActionType) as string[]

export const listPromptTemplates = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { actionType, isActive } = req.query

    const filter: any = {}
    if (actionType) filter.actionType = String(actionType)
    if (isActive !== undefined) filter.isActive = isActive === "true"

    const templates = await PromptTemplate.find(filter)
      .populate("updatedBy", "name email")
      .sort({ actionType: 1, version: -1 })

    return sendSuccess(res, 200, templates)
  } catch (error) {
    next(error)
  }
}

export const getActivePromptTemplate = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const actionType = Array.isArray(req.params.actionType)
      ? req.params.actionType[0]
      : req.params.actionType

    const template = await PromptTemplate.findOne({ actionType, isActive: true })
      .populate("updatedBy", "name email")

    if (!template) {
      throw new ApiError(404, `Không tìm thấy template active cho action '${actionType}'`, "TEMPLATE_NOT_FOUND")
    }

    return sendSuccess(res, 200, template)
  } catch (error) {
    next(error)
  }
}

export const getPromptTemplateHistory = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const actionType = Array.isArray(req.params.actionType)
      ? req.params.actionType[0]
      : req.params.actionType

    const history = await PromptTemplate.find({ actionType })
      .populate("updatedBy", "name email")
      .sort({ version: -1 })

    return sendSuccess(res, 200, history)
  } catch (error) {
    next(error)
  }
}

export const createPromptTemplate = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = (req as any).user?.id || (req as any).user?.userId
    const { actionType, template, provider, model, aiModel, maxTokens, temperature } = req.body

    if (!actionType || !template) {
      throw new ApiError(400, "actionType và template là bắt buộc", "MISSING_REQUIRED_FIELDS")
    }

    if (!VALID_ACTION_TYPES.includes(actionType)) {
      throw new ApiError(400, `actionType không hợp lệ. Phải thuộc: ${VALID_ACTION_TYPES.join(", ")}`, "INVALID_ACTION_TYPE")
    }

    const existingActive = await PromptTemplate.findOne({ actionType, isActive: true })
    if (existingActive) {
      throw new ApiError(400, `Action '${actionType}' đã có template. Hãy dùng PUT để cập nhật version mới.`, "TEMPLATE_EXISTS")
    }

    const newTemplate = await PromptTemplate.create({
      actionType,
      template,
      provider: provider || "openai",
      aiModel: model || aiModel || "gpt-4o-mini",
      maxTokens: maxTokens || 2048,
      temperature: temperature ?? 0.7,
      version: 1,
      isActive: true,
      updatedBy: new mongoose.Types.ObjectId(userId)
    })

    invalidatePromptCache(actionType)

    return sendSuccess(res, 201, newTemplate)
  } catch (error) {
    next(error)
  }
}

export const updatePromptTemplate = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = (req as any).user?.id || (req as any).user?.userId
    const actionType = Array.isArray(req.params.actionType)
      ? req.params.actionType[0]
      : req.params.actionType
    const { template, provider, model, aiModel, maxTokens, temperature } = req.body

    if (!template) {
      throw new ApiError(400, "Nội dung template là bắt buộc", "MISSING_TEMPLATE")
    }

    // Find latest version number
    const latestDoc = await PromptTemplate.findOne({ actionType }).sort({ version: -1 })
    const nextVersion = latestDoc ? latestDoc.version + 1 : 1

    // Deactivate all previous versions
    await PromptTemplate.updateMany({ actionType }, { isActive: false })

    // Create new version
    const newVersionDoc = await PromptTemplate.create({
      actionType,
      template,
      provider: provider || latestDoc?.provider || "openai",
      aiModel: model || aiModel || latestDoc?.aiModel || "gpt-4o-mini",
      maxTokens: maxTokens || latestDoc?.maxTokens || 2048,
      temperature: temperature ?? latestDoc?.temperature ?? 0.7,
      version: nextVersion,
      isActive: true,
      updatedBy: new mongoose.Types.ObjectId(userId)
    })

    invalidatePromptCache(actionType)

    return sendSuccess(res, 200, newVersionDoc)
  } catch (error) {
    next(error)
  }
}

export const activatePromptTemplateVersion = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const actionType = Array.isArray(req.params.actionType)
      ? req.params.actionType[0]
      : req.params.actionType
    const versionNum = parseInt(
      Array.isArray(req.params.version) ? req.params.version[0] : req.params.version,
      10
    )

    if (isNaN(versionNum)) {
      throw new ApiError(400, "Version không hợp lệ", "INVALID_VERSION")
    }

    const targetDoc = await PromptTemplate.findOne({ actionType, version: versionNum })
    if (!targetDoc) {
      throw new ApiError(404, `Không tìm thấy version ${versionNum} của action '${actionType}'`, "VERSION_NOT_FOUND")
    }

    // Deactivate all other versions
    await PromptTemplate.updateMany({ actionType }, { isActive: false })

    // Activate target version
    targetDoc.isActive = true
    await targetDoc.save()

    invalidatePromptCache(actionType)

    return sendSuccess(res, 200, targetDoc)
  } catch (error) {
    next(error)
  }
}
