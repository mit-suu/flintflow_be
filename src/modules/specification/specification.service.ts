import mongoose from "mongoose"
import { Section } from "./section.model.js"
import { SectionVersion } from "./section-version.model.js"
import { executeAiAction } from "../../shared/ai/ai-action.service.js"
import { ActionType } from "../../shared/ai/ai-action.types.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { Project } from "../project/project.model.js"

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Fetch a Section by projectId and type, or return null.
 */
const getSectionByType = async (projectId: string, sectionType: string) => {
  return Section.findOne({
    projectId: new mongoose.Types.ObjectId(projectId),
    type: sectionType
  } as any)
}

/**
 * Build project context string from business_goals and vision_problem sections.
 */
const buildProjectContext = async (projectId: string): Promise<string> => {
  const project = await Project.findById(projectId)
  const projectName = project?.name || "Unknown Project"
  const projectDomain = project?.domain || ""

  const [goalsSection, visionSection] = await Promise.all([
    getSectionByType(projectId, "business_goals"),
    getSectionByType(projectId, "vision_problem")
  ])

  const parts: string[] = [`Project: ${projectName}`]
  if (projectDomain) parts.push(`Domain: ${projectDomain}`)
  if (goalsSection?.content) {
    parts.push(
      `Business Goals: ${typeof goalsSection.content === "string" ? goalsSection.content : JSON.stringify(goalsSection.content)}`
    )
  }
  if (visionSection?.content) {
    parts.push(
      `Vision & Problem Statement: ${typeof visionSection.content === "string" ? visionSection.content : JSON.stringify(visionSection.content)}`
    )
  }

  return parts.join("\n\n")
}

/**
 * Create a new SectionVersion entry for audit / versioning.
 */
const createSectionVersion = async (
  sectionId: mongoose.Types.ObjectId,
  content: any,
  createdBy: "ai" | "user",
  diffSummary?: string
) => {
  // Find latest version number
  const latest = await SectionVersion.findOne({ sectionId })
    .sort({ versionNumber: -1 })
    .select("versionNumber")
    .lean()

  const nextVersion = (latest?.versionNumber ?? 0) + 1

  return SectionVersion.create({
    sectionId,
    versionNumber: nextVersion,
    content,
    diffSummary: diffSummary || null,
    createdBy
  })
}

// ─── UC34: Generate Priority Ranking (MoSCoW) ──────────────────────────────

export interface PrioritizedFR {
  id: string
  module: string
  featureName: string
  description: string
  verificationCondition?: string
  priority: "Must-have" | "Should-have" | "Could-have" | "Won't-have"
  priorityReason: string
  source?: string
}

export const generatePriorityRanking = async (
  projectId: string,
  userId: string
) => {
  // 1. Fetch functional_requirements section
  const frSection = await getSectionByType(projectId, "functional_requirements")

  if (!frSection || !frSection.content) {
    throw new ApiError(
      400,
      "Vui lòng sinh yêu cầu chức năng trước (UC31).",
      "FR_SECTION_NOT_FOUND"
    )
  }

  const functionalRequirements = frSection.content.functionalRequirements || frSection.content
  if (!Array.isArray(functionalRequirements) || functionalRequirements.length === 0) {
    throw new ApiError(
      400,
      "Danh sách yêu cầu chức năng đang rỗng. Vui lòng sinh yêu cầu chức năng trước.",
      "FR_LIST_EMPTY"
    )
  }

  // 2. Build project context for LLM
  const projectContext = await buildProjectContext(projectId)

  // 3. Call LLM via AI Action Framework (credit reserve/deduct handled internally)
  const aiResult = await executeAiAction<PrioritizedFR[]>(
    ActionType.PRIORITY_RANKING,
    {
      promptVariables: {
        project_context: projectContext,
        functional_requirements: JSON.stringify(functionalRequirements, null, 2)
      }
    },
    projectId,
    userId
  )

  const prioritizedList = aiResult.data

  // 4. Update functional_requirements section content with prioritized data
  if (frSection.content.functionalRequirements) {
    frSection.content.functionalRequirements = prioritizedList
  } else {
    frSection.content = prioritizedList
  }
  frSection.markModified("content")
  frSection.status = "draft"
  frSection.sourceType = "ai_generated"
  await frSection.save()

  // 5. Create version record
  await createSectionVersion(
    frSection._id as mongoose.Types.ObjectId,
    prioritizedList,
    "ai",
    "AI xếp hạng ưu tiên MoSCoW cho danh sách tính năng"
  )

  return {
    section: frSection,
    prioritizedFeatures: prioritizedList,
    aiMeta: {
      logId: aiResult.logId,
      cost: aiResult.cost,
      tokensUsed: aiResult.tokensUsed
    }
  }
}

// ─── UC35: Generate Scope & Out-of-Scope ────────────────────────────────────

export const generateScopeOutOfScope = async (
  projectId: string,
  userId: string
) => {
  // 1. Fetch functional_requirements section
  const frSection = await getSectionByType(projectId, "functional_requirements")

  if (!frSection || !frSection.content) {
    throw new ApiError(
      400,
      "Vui lòng sinh yêu cầu chức năng trước (UC31).",
      "FR_SECTION_NOT_FOUND"
    )
  }

  const functionalRequirements = frSection.content.functionalRequirements || frSection.content
  if (!Array.isArray(functionalRequirements) || functionalRequirements.length === 0) {
    throw new ApiError(
      400,
      "Danh sách yêu cầu chức năng đang rỗng.",
      "FR_LIST_EMPTY"
    )
  }

  // 2. Check that ALL features have been prioritized (UC34 must run first)
  const unprioritized = functionalRequirements.filter(
    (fr: any) => !fr.priority || fr.priority === null
  )
  if (unprioritized.length > 0) {
    throw new ApiError(
      400,
      `Vui lòng xếp hạng tính năng trước khi sinh Scope. Còn ${unprioritized.length} tính năng chưa được xếp hạng.`,
      "FEATURES_NOT_PRIORITIZED"
    )
  }

  // 3. Split into inScope and outScope based on MoSCoW
  const inScopeFeatures = functionalRequirements.filter(
    (fr: any) => fr.priority === "Must-have" || fr.priority === "Should-have" || fr.priority === "Could-have"
  )
  const outScopeFeatures = functionalRequirements.filter(
    (fr: any) => fr.priority === "Won't-have"
  )

  // 4. Build project context
  const projectContext = await buildProjectContext(projectId)

  // 5. Call LLM via AI Action Framework
  const aiResult = await executeAiAction<{ content: string }>(
    ActionType.SCOPE_OUT_OF_SCOPE,
    {
      promptVariables: {
        project_context: projectContext,
        in_scope_features: JSON.stringify(inScopeFeatures, null, 2),
        out_scope_features: JSON.stringify(outScopeFeatures, null, 2)
      }
    },
    projectId,
    userId
  )

  const markdownContent = aiResult.data.content

  // 6. Upsert Section "scope_out_of_scope"
  let scopeSection = await getSectionByType(projectId, "scope_out_of_scope")

  if (scopeSection) {
    scopeSection.content = markdownContent
    scopeSection.markModified("content")
    scopeSection.status = "draft"
    scopeSection.sourceType = "ai_generated"
    await scopeSection.save()
  } else {
    scopeSection = await Section.create({
      projectId: new mongoose.Types.ObjectId(projectId),
      type: "scope_out_of_scope",
      content: markdownContent,
      status: "draft",
      sourceType: "ai_generated",
      order: 10
    })
  }

  // 7. Create version record
  await createSectionVersion(
    scopeSection._id as mongoose.Types.ObjectId,
    markdownContent,
    "ai",
    "AI sinh Scope & Out-of-Scope từ danh sách tính năng đã phân hạng MoSCoW"
  )

  return {
    section: scopeSection,
    scopeContent: markdownContent,
    aiMeta: {
      logId: aiResult.logId,
      cost: aiResult.cost,
      tokensUsed: aiResult.tokensUsed
    }
  }
}
