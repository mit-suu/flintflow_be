import mongoose from "mongoose"
import dotenv from "dotenv"
import { env } from "../config/env.js"
import { User } from "../modules/user/user.model.js"
import { PromptTemplate } from "../modules/admin/prompt-template.model.js"
import { ActionType } from "../shared/ai/ai-action.types.js"

dotenv.config()

const SEED_TEMPLATES = [
  {
    actionType: ActionType.SUMMARIZE,
    template: `Tóm tắt nội dung sau một cách ngắn gọn, súc tích, làm nổi bật các ý chính.

YÊU CẦU: Chỉ trả về JSON thuần túy (không markdown, không giải thích thêm) theo đúng định dạng sau:
{"summary": "<tóm tắt ngắn gọn>", "keyPoints": ["<ý chính 1>", "<ý chính 2>", "<ý chính 3>"]}

Nội dung cần tóm tắt:
{{input_text}}`,
    provider: "gemini",
    model: "gemini-2.5-flash",
    maxTokens: 1024,
    temperature: 0.3
  },
  {
    actionType: ActionType.EXTRACT,
    template: `Trích xuất các thông tin chính từ văn bản yêu cầu phần mềm sau.

YÊU CẦU: Chỉ trả về JSON thuần túy (không markdown, không giải thích thêm) theo đúng định dạng sau:
{"title": "<tiêu đề dự án>", "requirements": ["<yêu cầu 1>", "<yêu cầu 2>"], "entities": [], "attributes": {}}

Văn bản:
{{input_text}}`,
    provider: "gemini",
    model: "gemini-2.5-flash",
    maxTokens: 2048,
    temperature: 0.3
  },
  {
    actionType: ActionType.ANALYSIS,
    template: `Phân tích yêu cầu phần mềm sau về mục tiêu kinh doanh, đối tượng người dùng, ràng buộc kỹ thuật và rủi ro tiềm ẩn.

YÊU CẦU: Chỉ trả về JSON thuần túy (không markdown, không giải thích thêm) theo đúng định dạng sau:
{"businessGoals": ["<mục tiêu 1>"], "targetUsers": ["<người dùng 1>"], "risks": ["<rủi ro 1>"], "constraints": ["<ràng buộc 1>"], "summary": "<tóm tắt phân tích>"}

Văn bản:
{{input_text}}`,
    provider: "gemini",
    model: "gemini-2.5-flash",
    maxTokens: 2048,
    temperature: 0.5
  },
  {
    actionType: ActionType.CLARIFICATION,
    template: `Đưa ra danh sách các câu hỏi làm rõ đúng trọng tâm để giải quyết các điểm mờ nhạt trong yêu cầu phần mềm sau.

YÊU CẦU: Chỉ trả về JSON thuần túy (không markdown, không giải thích thêm) theo đúng định dạng sau:
{"questions": [{"id": "q1", "question": "<câu hỏi làm rõ>", "reason": "<lý do cần làm rõ>"}]}

Yêu cầu phần mềm:
{{input_text}}`,
    provider: "gemini",
    model: "gemini-2.5-flash",
    maxTokens: 2048,
    temperature: 0.7
  },
  {
    actionType: ActionType.GENERATE_SECTION,
    template: `Viết tài liệu đặc tả chi tiết cho phần {{section_name}} dựa trên ngữ cảnh dự án sau.

YÊU CẦU: Chỉ trả về JSON thuần túy (không markdown, không giải thích thêm) theo đúng định dạng sau:
{"sectionName": "{{section_name}}", "content": "<nội dung đặc tả chi tiết>", "subSections": []}

Ngữ cảnh dự án:
{{context}}`,
    provider: "gemini",
    model: "gemini-2.5-flash",
    maxTokens: 3000,
    temperature: 0.7
  },
  {
    actionType: ActionType.VERIFICATION,
    template: `Kiểm tra rà soát khoảng trống, điểm mâu thuẫn, giả định ngầm và mức độ hoàn thiện của tài liệu đặc tả phần mềm sau.

YÊU CẦU: Chỉ trả về JSON thuần túy (không markdown, không giải thích thêm) theo đúng định dạng sau:
{"score": <điểm 0-100>, "overallStatus": "<good|needs_improvement|poor>", "issues": [{"severity": "<high|medium|low>", "description": "<mô tả vấn đề>", "suggestion": "<gợi ý sửa>"}]}

Tài liệu đặc tả:
{{specification}}`,
    provider: "gemini",
    model: "gemini-2.5-flash",
    maxTokens: 2048,
    temperature: 0.3
  },
  {
    actionType: ActionType.REWRITE,
    template: `Viết lại nội dung sau cho mạch lạc, chuyên nghiệp, chuẩn mực tài liệu kỹ thuật phần mềm.

YÊU CẦU: Chỉ trả về JSON thuần túy (không markdown, không giải thích thêm) theo đúng định dạng sau:
{"rewrittenContent": "<nội dung đã viết lại>", "changesSummary": "<tóm tắt các thay đổi đã thực hiện>"}

Nội dung gốc:
{{content}}`,
    provider: "gemini",
    model: "gemini-2.5-flash",
    maxTokens: 2048,
    temperature: 0.5
  }
]

export const seedPromptTemplates = async () => {
  try {
    console.log("[Seed] Connecting to MongoDB...")
    await mongoose.connect(env.MONGO_URI)

    let adminUser = await User.findOne({ role: "admin" })
    if (!adminUser) {
      adminUser = await User.findOne({})
    }

    if (!adminUser) {
      console.error("[Seed] No user found in DB. Please create a user/admin first.")
      process.exit(1)
    }

    console.log(`[Seed] Using admin user ID: ${adminUser._id}`)

    for (const item of SEED_TEMPLATES) {
      const latestDoc = await PromptTemplate.findOne({ actionType: item.actionType }).sort({ version: -1 })

      if (!latestDoc) {
        // No existing template: create version 1
        await PromptTemplate.create({
          actionType: item.actionType,
          template: item.template,
          provider: item.provider,
          aiModel: item.model,
          maxTokens: item.maxTokens,
          temperature: item.temperature,
          version: 1,
          isActive: true,
          updatedBy: adminUser!._id
        })
        console.log(`[Seed] ✅ Created prompt template for action '${item.actionType}' (v1)`)
      } else if (
        latestDoc.template.trim() !== item.template.trim() ||
        latestDoc.provider !== item.provider ||
        latestDoc.aiModel !== item.model
      ) {
        // Template changed: deactivate all old versions and create new version
        await PromptTemplate.updateMany({ actionType: item.actionType }, { isActive: false })
        const nextVersion = latestDoc.version + 1
        await PromptTemplate.create({
          actionType: item.actionType,
          template: item.template,
          provider: item.provider,
          aiModel: item.model,
          maxTokens: item.maxTokens,
          temperature: item.temperature,
          version: nextVersion,
          isActive: true,
          updatedBy: adminUser!._id
        })
        console.log(`[Seed] 🔄 Updated prompt template for action '${item.actionType}' → v${nextVersion}`)
      } else {
        console.log(`[Seed] ℹ️  Prompt template for action '${item.actionType}' is already up to date (v${latestDoc.version}). Skipped.`)
      }
    }

    console.log("[Seed] Done seeding prompt templates!")
  } catch (error) {
    console.error("[Seed] Error seeding prompt templates:", error)
  } finally {
    await mongoose.disconnect()
  }
}

if (process.argv[1]?.includes("seed-prompt-templates")) {
  seedPromptTemplates()
}
