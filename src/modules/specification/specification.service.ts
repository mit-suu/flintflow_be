import mongoose from "mongoose"
import { Section, ISection, SectionType } from "./section.model.js"
import { SectionVersion } from "./section-version.model.js"
import { executeAiAction } from "../../shared/ai/ai-action.service.js"
import { ActionType } from "../../shared/ai/ai-action.types.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { Project } from "../project/project.model.js"
import { ChatSession } from "../project/chat-session.model.js"
import { buildDocumentContext } from "../../shared/ai/document-context.service.js"
import { getPromptTemplate } from "../../shared/ai/prompt-registry.service.js"
import {
  saveSourceLinks,
  extractSourceLinksFromAiResponse
} from "./traceability.service.js"
import {
  canAccessPhase,
  canModifySection,
  checkAndAdvancePhase
} from "./phase-gate.service.js"
import {
  WorkspacePhase,
  WORKSPACE_PHASE_MAP,
  getAllMappedSections
} from "../../shared/constants/section-types.js"

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

import { SECTION_METADATA } from "../../shared/constants/section-types.js"

const getSectionOrder = (type: SectionType): number => {
  return SECTION_METADATA[type]?.order || 99
}

const getSectionName = (type: SectionType): string => {
  return SECTION_METADATA[type]?.label || type
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
  // Phase Gate Check: Kiểm tra quyền chỉnh sửa section (khóa baseline nếu phase trước đã accepted)
  const modCheck = await canModifySection(projectId, type)
  if (!modCheck.allowed) {
    throw new ApiError(403, modCheck.reason || "Section is locked", "SECTION_LOCKED")
  }

  // Phase Gate Check: Nếu tạo mới section, phải được quyền truy cập phase của section đó
  const meta = SECTION_METADATA[type]
  if (meta) {
    const accessCheck = await canAccessPhase(projectId, meta.phase)
    if (!accessCheck.allowed) {
      throw new ApiError(403, accessCheck.reason || "Phase is locked", "PHASE_LOCKED")
    }
  }

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
    diffSummary: nextVerNum === 1 ? "Bản phác thảo đầu tiên" : (status === "accepted" ? "Nghiệm thu tài liệu (Accepted)" : "Cập nhật tài liệu")
  })

  // Phase Gate: Khi section chuyển sang "accepted", kiểm tra và tự động mở khóa phase tiếp theo nếu đủ điều kiện
  if (status === "accepted") {
    await checkAndAdvancePhase(projectId)
  }

  return section
}

/**
 * Nghiệm thu (Accept) một Section đặc tả.
 * Tự động kích hoạt kiểm tra và nâng phase nếu toàn bộ section bắt buộc của phase đã accepted.
 */
export const acceptSection = async (
  projectId: string,
  type: SectionType,
  userId: string
): Promise<{ section: ISection; phaseProgression: any }> => {
  const section = await Section.findOne({ projectId, type })
  if (!section) {
    throw new ApiError(404, "Section not found. Please generate or create it before accepting.", "SECTION_NOT_FOUND")
  }

  const projectBefore = await Project.findById(projectId).select("currentPhase").lean()
  const oldPhase = (projectBefore?.currentPhase || 2) as 2 | 3 | 4

  const updatedSection = await saveSection(
    projectId,
    type,
    section.content,
    "user",
    section.sourceType,
    "accepted"
  )

  const projectAfter = await Project.findById(projectId).select("currentPhase progressPercent").lean()
  const newPhase = (projectAfter?.currentPhase || 2) as 2 | 3 | 4

  return {
    section: updatedSection,
    phaseProgression: {
      advanced: newPhase > oldPhase,
      oldPhase,
      newPhase,
      progressPercent: projectAfter?.progressPercent || 0
    }
  }
}



// ─── Chat-based Section Generation (feat/flf-74-input-modules) ───────────────

export const generateSection = async (
  projectId: string,
  type: SectionType,
  chatSessionId: string,
  userId: string
): Promise<ISection> => {
  // Phase Gate Check: Kiểm tra quyền truy cập Phase
  const meta = SECTION_METADATA[type]
  if (meta) {
    const accessCheck = await canAccessPhase(projectId, meta.phase)
    if (!accessCheck.allowed) {
      throw new ApiError(403, accessCheck.reason || `Phase ${meta.phase} is locked`, "PHASE_LOCKED")
    }

    const modCheck = await canModifySection(projectId, type)
    if (!modCheck.allowed) {
      throw new ApiError(403, modCheck.reason || "Section is locked", "SECTION_LOCKED")
    }
  }

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

  // Task 2c: Build document context theo SectionType
  const template = await getPromptTemplate(ActionType.GENERATE_SECTION)
  const docContext = await buildDocumentContext(
    projectId,
    ActionType.GENERATE_SECTION,
    type,            // sectionType — dùng SECTION_NEEDS_SOURCE_DOCUMENTS map
    0,               // chat không có history token ở đây (context đã trong `context`)
    template.providerConfig.model,
    template.providerConfig.maxTokens
  )

  if (docContext.documentsUsed > 0) {
    console.log(
      `[SpecService] Injecting ${docContext.documentsUsed} document(s) into GENERATE_SECTION prompt for type='${type}' (usedSummary=${docContext.usedSummary})`
    )
  }

  const aiResult = await executeAiAction(
    ActionType.GENERATE_SECTION,
    {
      promptVariables: {
        section_name: sectionName,
        context: context || "Không có ngữ cảnh bổ sung từ chat.",
        documentContext: docContext.contextText  // rỗng nếu không cần
      }
    },
    projectId,
    userId
  )

  // aiResult.data conforms to generateSectionSchema: { sectionName, content, subSections }
  const generatedContent = aiResult.data.content || aiResult.rawText

  const savedSection = await saveSection(
    projectId,
    type,
    generatedContent,
    "ai",
    "ai_generated",
    "draft"
  )

  // Task 2d: Lưu traceability links sau khi Section đã lưu thành công
  // Non-blocking: mọi lỗi traceability chỉ log, không chặn response
  if (docContext.documentsUsed > 0) {
    try {
      const rawLinks = extractSourceLinksFromAiResponse(aiResult.data)
      if (rawLinks && rawLinks.length > 0) {
        const traceStats = await saveSourceLinks(
          savedSection._id as any,
          projectId,
          rawLinks
        )
        console.log(
          `[Traceability] Section '${type}': saved=${traceStats.saved}, rejected=${traceStats.rejected}, skipped=${traceStats.skipped}`
        )
      }
    } catch (traceErr: any) {
      console.warn(`[Traceability] Non-blocking error for section '${type}': ${traceErr?.message}`)
    }
  }

  return savedSection
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
  // Phase Gate Check: Priority Ranking thuộc Phase 3 -> yêu cầu Phase 2 hoàn thành
  const accessCheck = await canAccessPhase(projectId, 3)
  if (!accessCheck.allowed) {
    throw new ApiError(403, accessCheck.reason || "Phase 3 is locked", "PHASE_LOCKED")
  }

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
  // Phase Gate Check: Scope & Out-of-Scope thuộc Phase 3 -> yêu cầu Phase 2 hoàn thành
  const accessCheck = await canAccessPhase(projectId, 3)
  if (!accessCheck.allowed) {
    throw new ApiError(403, accessCheck.reason || "Phase 3 is locked", "PHASE_LOCKED")
  }

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

// ─── Batch Phase Generation (Milestone 2) ───────────────────────────────────

export interface GeneratePhaseResult {
  generated: ISection[]
  errors: Array<{ type: string; error: string }>
}

/**
 * Sinh hàng loạt (batch generate) tất cả các section thuộc một WorkspacePhase.
 * Tiếp tục sinh các section còn lại nếu có 1 section bị lỗi.
 */
export const generatePhase = async (
  projectId: string,
  workspacePhase: WorkspacePhase,
  chatSessionId: string,
  userId: string
): Promise<GeneratePhaseResult> => {
  const phaseConfig = WORKSPACE_PHASE_MAP[workspacePhase]
  if (!phaseConfig || !phaseConfig.sectionTypes || phaseConfig.sectionTypes.length === 0) {
    throw new ApiError(
      400,
      `Phase "${workspacePhase}" does not support batch generation or has no section types.`,
      "INVALID_WORKSPACE_PHASE"
    )
  }

  const generated: ISection[] = []
  const errors: Array<{ type: string; error: string }> = []

  for (const sectionType of phaseConfig.sectionTypes) {
    try {
      const section = await generateSection(projectId, sectionType, chatSessionId, userId)
      generated.push(section)
    } catch (err: any) {
      console.warn(`[SpecService] Batch generate error for section "${sectionType}": ${err?.message}`)
      errors.push({
        type: sectionType,
        error: err?.message || "Unknown generation error"
      })
    }
  }

  return { generated, errors }
}

// ─── UC 6.14: Approve SRS for Handoff (Milestone 4 Baseline) ────────────────

export interface ApproveSRSResult {
  project: any
  baselineVersion: string
  approvedAt: Date
  exportEnabled: boolean
}

/**
 * UC 6.14 - Approve SRS for Handoff
 * Tạo bản SRS Baseline v1.0, khóa các section và mở khóa Export.
 */
export const approveSRSForHandoff = async (
  projectId: string,
  userId: string
): Promise<ApproveSRSResult> => {
  const project = await Project.findById(projectId)
  if (!project) {
    throw new ApiError(404, "Project not found", "PROJECT_NOT_FOUND")
  }

  // Kiểm tra điều kiện: Tất cả 22 section bắt buộc đã được accepted
  const allMapped = getAllMappedSections()
  const acceptedSections = await Section.find({
    projectId: new mongoose.Types.ObjectId(projectId),
    type: { $in: allMapped },
    status: "accepted"
  }).select("type").lean()

  const acceptedSet = new Set(acceptedSections.map((s) => s.type))
  const unaccepted = allMapped.filter((t) => !acceptedSet.has(t))

  if (unaccepted.length > 0) {
    throw new ApiError(
      400,
      `Chưa thể phê duyệt SRS Baseline v1.0. Còn ${unaccepted.length} section chưa được nghiệm thu: ${unaccepted.join(", ")}`,
      "SECTIONS_NOT_ALL_ACCEPTED"
    )
  }

  const baselineVersion = project.baselineVersion || "v1.0"
  project.baselineVersion = baselineVersion
  project.workspacePhase = "export"
  project.progressPercent = 100
  await project.save()

  console.log(`[SpecService] 🏆 Project "${project.name}" (${projectId}) approved for handoff as Baseline ${baselineVersion}!`)

  return {
    project,
    baselineVersion,
    approvedAt: new Date(),
    exportEnabled: true
  }
}

// ─── Discovery → Generation Phase Transition ────────────────────────────────

/**
 * Chuyển project từ Discovery sang Generation phase đầu tiên (product_overview).
 * Gọi khi user approve Product Brief Summary trong Discovery chat.
 */
export const advanceToGenerationPhase = async (projectId: string) => {
  const project = await Project.findById(projectId)
  if (!project) throw new ApiError(404, "Project not found", "NOT_FOUND")

  if (project.workspacePhase !== "discovery") {
    throw new ApiError(400, "Project is not in discovery phase", "INVALID_PHASE")
  }

  project.workspacePhase = "product_overview"
  await project.save()

  return { workspacePhase: project.workspacePhase }
}
