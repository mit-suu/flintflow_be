import mongoose from "mongoose"
import { Section, ISection, SectionType } from "./section.model.js"
import { SectionVersion } from "./section-version.model.js"
import { ChatSession } from "../project/chat-session.model.js"
import { executeAiAction } from "../../shared/ai/ai-action.service.js"
import { ActionType } from "../../shared/ai/ai-action.types.js"
import { ApiError } from "../../shared/utils/api-error.js"

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
