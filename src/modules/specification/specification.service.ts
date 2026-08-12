import mongoose from "mongoose"
import { Section, ISection, SectionType } from "./section.model.js"
import { SectionVersion } from "./section-version.model.js"
import { executeAiAction } from "../../shared/ai/ai-action.service.js"
import { ActionType } from "../../shared/ai/ai-action.types.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { Project } from "../project/project.model.js"
import { ChatSession } from "../project/chat-session.model.js"

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

const getSectionOrder = (type: SectionType): number => {
  const orders: Record<SectionType, number> = {
    business_goals: 1,
    stakeholders: 2,
    vision_problem: 3,
    value_proposition: 4,
    user_journey: 5,
    functional_requirements: 6,
    non_functional_requirements: 7,
    rbac: 8,
    priority_ranking: 9,
    scope_out_of_scope: 10,
    assumptions_risks: 11,
    acceptance_criteria: 12,
    user_story: 13,
    use_case_spec: 14,
    success_metrics: 15
  }
  return orders[type] || 99
}

const getSectionName = (type: SectionType): string => {
  const names: Record<SectionType, string> = {
    business_goals: "Business Goals (Mục tiêu kinh doanh)",
    stakeholders: "Stakeholders / Target Users (Đối tượng người dùng mục tiêu)",
    vision_problem: "Vision & Problem (Tầm nhìn & Vấn đề)",
    value_proposition: "Value Proposition (Giá trị cốt lõi)",
    user_journey: "User Journey (Hành trình người dùng)",
    functional_requirements: "Functional Requirements (Yêu cầu chức năng)",
    non_functional_requirements: "Non-functional Requirements (Yêu cầu phi chức năng)",
    rbac: "RBAC (Phân quyền người dùng)",
    priority_ranking: "Priority Ranking (Thứ tự ưu tiên)",
    scope_out_of_scope: "Scope & Out of Scope (Phạm vi & Ngoài phạm vi)",
    assumptions_risks: "Assumptions & Risks (Giả định & Rủi ro)",
    acceptance_criteria: "Acceptance Criteria (Tiêu chí nghiệm thu)",
    user_story: "User Stories (Câu chuyện người dùng)",
    use_case_spec: "Use Case Specifications (Đặc tả ca sử dụng)",
    success_metrics: "Success Metrics (Chỉ số đo lường thành công)"
  }
  return names[type] || type
}

// ─── Basic CRUD ──────────────────────────────────────────────────────────────

export const getSections = async (projectId: string): Promise<ISection[]> => {
  return await Section.find({ projectId }).sort({ order: 1 })
}

export const saveSection = async (
  projectId: string,
  type: SectionType,
  content: any,
  createdBy: "ai" | "user",
  sourceType: "ai_generated" | "user_edited",
  status: "draft" | "accepted" | "edited_manually" | "regenerated"
): Promise<ISection> => {
  let section = await Section.findOne({ projectId, type })

  if (!section) {
    section = new Section({
      projectId: new mongoose.Types.ObjectId(projectId),
      type,
      content,
      status,
      sourceType,
      order: getSectionOrder(type)
    })
  } else {
    section.content = content
    section.status = status
    section.sourceType = sourceType
  }

  await section.save()

  // Find latest version number
  const latestVer = await SectionVersion.findOne({ sectionId: section._id })
    .sort({ versionNumber: -1 })
    .select("versionNumber")

  const nextVerNum = latestVer ? latestVer.versionNumber + 1 : 1

  await SectionVersion.create({
    sectionId: section._id,
    versionNumber: nextVerNum,
    content,
    createdBy,
    diffSummary: nextVerNum === 1 ? "Bản phác thảo đầu tiên" : "Cập nhật tài liệu"
  })

  return section
}

// ─── Chat-based Section Generation (feat/flf-74-input-modules) ───────────────

export const generateSection = async (
  projectId: string,
  type: SectionType,
  chatSessionId: string,
  userId: string
): Promise<ISection> => {
  const session = await ChatSession.findById(chatSessionId)
  if (!session) {
    throw new ApiError(404, "Chat session not found", "CHAT_SESSION_NOT_FOUND")
  }

  // Compile context from messages
  const context = session.messages
    .map((msg) => {
      let text = msg.content
      if (msg.role === "ai" && text.startsWith("{") && text.endsWith("}")) {
        try {
          const parsed = JSON.parse(text)
          text = parsed.reply || text
        } catch (_) {}
      }
      return `${msg.role === "user" ? "User" : "AI"}: ${text}`
    })
    .join("\n")

  const sectionName = getSectionName(type)

  const aiResult = await executeAiAction(
    ActionType.GENERATE_SECTION,
    {
      promptVariables: {
        section_name: sectionName,
        context: context || "Không có ngữ cảnh bổ sung từ chat."
      }
    },
    projectId,
    userId
  )

  // aiResult.data conforms to generateSectionSchema: { sectionName, content, subSections }
  const generatedContent = aiResult.data.content || aiResult.rawText

  return await saveSection(
    projectId,
    type,
    generatedContent,
    "ai",
    "ai_generated",
    "draft"
  )
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
