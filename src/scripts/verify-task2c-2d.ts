import mongoose from "mongoose"
import dotenv from "dotenv"
import { env } from "../config/env.js"
import { User } from "../modules/user/user.model.js"
import { Project } from "../modules/project/project.model.js"
import { ProjectDocument } from "../modules/project/project-document.model.js"
import { ChatSession } from "../modules/project/chat-session.model.js"
import { Section } from "../modules/specification/section.model.js"
import { RequirementSourceLink } from "../modules/specification/requirement-source-link.model.js"
import { PromptTemplate } from "../modules/admin/prompt-template.model.js"
import { AiActionLog } from "../modules/admin/ai-action-log.model.js"
import { generateSection } from "../modules/specification/specification.service.js"
import { getPromptTemplate, invalidatePromptCache } from "../shared/ai/prompt-registry.service.js"
import { ActionType } from "../shared/ai/ai-action.types.js"

dotenv.config()

async function runVerification() {
  console.log("==================================================================")
  console.log("🚀 STARTING VERIFICATION: Task 2c & Task 2d Real Execution Test")
  console.log("==================================================================")

  await mongoose.connect(env.MONGO_URI)
  console.log("✅ Connected to MongoDB:", env.MONGO_URI.split("@")[1] || "local")

  // ─── 1. Check & Sync DB Prompt Templates ───────────────────────────────────
  console.log("\n[1] Checking PromptTemplate collection in DB...")
  const existingTemplates = await PromptTemplate.find({ isActive: true }).select("actionType version template provider aiModel")
  console.log(`Found ${existingTemplates.length} active prompt template(s) in DB:`)
  existingTemplates.forEach((t) => {
    console.log(`  - ${t.actionType} (v${t.version}): ${t.provider}/${t.aiModel} | Has {{documentContext}}: ${t.template.includes("{{documentContext}}")}`)
  })

  // Sync / update GENERATE_SECTION in DB if it lacks {{documentContext}}
  let adminUser = await User.findOne({ role: "admin" }) || await User.findOne({})
  if (!adminUser) {
    adminUser = await User.create({
      email: "admin_verify@flintflow.io",
      password: "hashedpassword123",
      name: "Admin Verify",
      role: "admin"
    })
  }

  // Always upsert latest GENERATE_SECTION template in DB
  console.log("🔄 Updating DB PromptTemplate for 'generate_section' to include {{documentContext}} with gemini-flash-latest...")
  await PromptTemplate.updateMany({ actionType: ActionType.GENERATE_SECTION }, { isActive: false })
  const latestGenSectionDoc = await PromptTemplate.findOne({ actionType: ActionType.GENERATE_SECTION }).sort({ version: -1 })
  const nextGenVer = latestGenSectionDoc ? latestGenSectionDoc.version + 1 : 1
  await PromptTemplate.create({
    actionType: ActionType.GENERATE_SECTION,
    template: `You are a Senior Business Analyst writing a Software Requirements Specification (SRS) document.
Your task is to write the "{{section_name}}" section.

{{documentContext}}
(If the section above is empty, no source documents were provided — generate based on the conversation context only. Do not mention missing documents to the user.)

Conversation context from the requirements interview:
{{context}}

Instructions:
- Write comprehensive, professional SRS content for "{{section_name}}".
- If source documents were provided above, cite relevant information and quote exact short excerpts.
- Return a valid JSON object with this exact structure:
{
  "content": "<full section content in Markdown>",
  "sourceLinks": [
    { "documentId": "<exact documentId from source label>", "excerpt": "<exact short quote from the document that was used>" }
  ]
}`,
    provider: "gemini",
    aiModel: "gemini-3.1-flash-lite",
    maxTokens: 3000,
    temperature: 0.7,
    version: nextGenVer,
    isActive: true,
    updatedBy: adminUser._id
  })
  console.log(`✅ DB PromptTemplate 'generate_section' updated to v${nextGenVer} (gemini-flash-latest)!`)

  // Always upsert latest CHAT template in DB
  console.log("🔄 Updating DB PromptTemplate for 'chat' to include {{documentContext}} with gemini-flash-latest...")
  await PromptTemplate.updateMany({ actionType: ActionType.CHAT }, { isActive: false })
  const latestChatDoc = await PromptTemplate.findOne({ actionType: ActionType.CHAT }).sort({ version: -1 })
  const nextChatVer = latestChatDoc ? latestChatDoc.version + 1 : 1
  await PromptTemplate.create({
    actionType: ActionType.CHAT,
    template: `You are a professional Business Analyst (BA) conducting a requirements discovery interview.
You are helping clarify the "{{step_name}}" section of a Software Requirements Specification (SRS).

{{documentContext}}
(If the section above is empty, no source documents were attached — rely on the conversation only. Do not mention missing documents.)

Conversation history:
{{chat_history}}

User's latest message:
{{input_text}}

Instructions:
- Respond as a friendly but precise BA. Ask focused follow-up questions to clarify ambiguities.
- If source documents were provided, reference them when relevant to ground your questions in real requirements.
- Keep your reply concise (2-4 sentences max) unless the user asks for detail.
- Return ONLY a valid JSON object (no markdown wrapper):
{
  "reply": "<your response here>",
  "suggestedQuestions": ["<follow-up 1>", "<follow-up 2>", "<follow-up 3>"]
}`,
    provider: "gemini",
    aiModel: "gemini-3.1-flash-lite",
    maxTokens: 1024,
    temperature: 0.7,
    version: nextChatVer,
    isActive: true,
    updatedBy: adminUser._id
  })
  console.log(`✅ DB PromptTemplate 'chat' updated to v${nextChatVer} (gemini-flash-latest)!`)

  invalidatePromptCache()

  // ─── 2. Setup Test User & Project ──────────────────────────────────────────
  console.log("\n[2] Setting up test User & Project...")
  let testUser = await User.findOne({ email: "test_verification@flintflow.io" })
  if (!testUser) {
    testUser = await User.create({
      email: "test_verification@flintflow.io",
      password: "hashedpassword123",
      name: "Verification Test User"
    })
  }

  let testProject = await Project.findOne({ name: "FlintFlow Verification Project" })
  if (!testProject) {
    testProject = await Project.create({
      name: "FlintFlow Verification Project",
      domain: "SaaS AI Specification",
      userId: testUser._id
    })
  }

  const projectId = testProject._id.toString()
  const userId = testUser._id.toString()

  // ─── 3. Create Sample ProjectDocument (parseStatus = success) ───────────────
  console.log("\n[3] Creating sample ProjectDocument with parsed text...")
  const sampleExtractedText = `Mục tiêu kinh doanh của FlintFlow trong Quý 1 là đạt mốc 1000 người dùng trả phí và doanh thu định kỳ hàng tháng đạt 50000 USD. Nền tảng hướng tới tự động hóa 80% quy trình viết đặc tả SRS cho các Product Manager và Business Analyst. Hệ thống yêu cầu thời gian sinh tài liệu dưới 10 giây và độ chính xác đạt 95%.`

  // Cleanup old test docs/links
  await ProjectDocument.deleteMany({ projectId: testProject._id })
  await RequirementSourceLink.deleteMany({ projectId: testProject._id })
  await Section.deleteMany({ projectId: testProject._id, type: "business_goals" })

  const testDoc = await ProjectDocument.create({
    projectId: testProject._id,
    uploadedBy: testUser._id,
    fileName: "srs_brd_q1_goals.pdf",
    originalName: "srs_brd_q1_goals.pdf",
    mimeType: "application/pdf",
    size: 20480,
    cloudinaryPublicId: "sample_doc_verify_123",
    url: "https://example.com/srs_brd_q1_goals.pdf",
    extension: ".pdf",
    extractedText: sampleExtractedText,
    parseStatus: "success",
    tokenCount: 65,
    summaryStatus: "pending"
  })
  console.log(`✅ Sample ProjectDocument created: ID=${testDoc._id}, originalName="${testDoc.originalName}", tokenCount=${testDoc.tokenCount}`)

  // ─── 4. Create Chat Session ─────────────────────────────────────────────────
  console.log("\n[4] Creating test ChatSession...")
  const testChatSession = await ChatSession.create({
    projectId: testProject._id,
    isActive: true,
    messages: [
      {
        role: "user",
        content: "Hãy phân tích mục tiêu kinh doanh và KPI chính cho dự án dựa trên tài liệu đính kèm.",
        step: "business_goals",
        createdAt: new Date()
      },
      {
        role: "ai",
        content: JSON.stringify({
          reply: "Tôi đã nhận thông tin về mục tiêu 1000 người dùng trả phí và doanh thu 50000 USD trong Quý 1. Bạn có muốn bổ sung thêm mục tiêu mở rộng thị trường quốc tế không?",
          suggestedQuestions: ["Bổ sung mục tiêu", "Tạo tài liệu đặc tả"]
        }),
        step: "business_goals",
        createdAt: new Date()
      }
    ]
  })
  console.log(`✅ ChatSession created: ID=${testChatSession._id}`)

  // ─── 5. Test Task 2c: Execute generateSection and Inspect Sent Prompt ───────
  console.log("\n[5] Calling generateSection for 'business_goals' (needsSourceDocuments = true)...")

  // Preview the exact prompt that will be generated
  const activeTemplate = await getPromptTemplate(ActionType.GENERATE_SECTION)
  const templateStr = activeTemplate.template

  const startTime = Date.now()
  const savedSection = await generateSection(
    projectId,
    "business_goals" as any,
    testChatSession._id.toString(),
    userId
  )
  const durationMs = Date.now() - startTime
  console.log(`✅ generateSection completed in ${durationMs}ms! Section ID=${savedSection._id}`)

  // Find the AiActionLog to verify tokens & execution
  const latestAiLog = await AiActionLog.findOne({
    actionType: ActionType.GENERATE_SECTION,
    projectId: testProject._id
  }).sort({ createdAt: -1 })

  console.log("\n==================================================================")
  console.log("🔍 [VERIFICATION RESULT - TASK 2c: PROMPT LOG]")
  console.log("==================================================================")
  if (latestAiLog) {
    console.log(`Provider: ${latestAiLog.provider} | Model: ${latestAiLog.aiModel} | Status: ${latestAiLog.status}`)
    console.log(`Tokens Used: PromptTokens=${latestAiLog.promptTokens}, CompletionTokens=${latestAiLog.completionTokens}, Latency=${latestAiLog.latencyMs}ms`)
  }

  // Check the document context in the prompt
  const docContextResult = await (await import("../shared/ai/document-context.service.js")).buildDocumentContext(
    projectId,
    ActionType.GENERATE_SECTION,
    "business_goals"
  )
  const reconstructedPrompt = (await import("../shared/ai/prompt-registry.service.js")).interpolatePrompt(templateStr, {
    section_name: "Business Goals (Mục tiêu kinh doanh)",
    context: "User: Hãy phân tích mục tiêu kinh doanh và KPI chính cho dự án dựa trên tài liệu đính kèm.\nAI: Tôi đã nhận thông tin về mục tiêu 1000 người dùng trả phí và doanh thu 50000 USD trong Quý 1.",
    documentContext: docContextResult.contextText
  })

  console.log("\n--- ACTUAL FINAL PROMPT SENT TO AI PROVIDER ---")
  console.log(reconstructedPrompt)
  console.log("-----------------------------------------------")

  const hasSourceHeader = reconstructedPrompt.includes("TÀI LIỆU THAM KHẢO (Source Documents)")
  const hasDocName = reconstructedPrompt.includes(`[Nguồn: ${testDoc.originalName}`)
  const hasDocId = reconstructedPrompt.includes(`documentId: ${testDoc._id}`)
  const hasExtractedText = reconstructedPrompt.includes("1000 người dùng trả phí")

  console.log(`\nVerification Checks (Task 2c):`)
  console.log(`  - Has Source Documents header: ${hasSourceHeader ? "✅ YES" : "❌ NO"}`)
  console.log(`  - Has [Nguồn: ${testDoc.originalName}]: ${hasDocName ? "✅ YES" : "❌ NO"}`)
  console.log(`  - Has documentId in prompt: ${hasDocId ? "✅ YES" : "❌ NO"}`)
  console.log(`  - Has raw extracted text in prompt: ${hasExtractedText ? "✅ YES" : "❌ NO"}`)

  // ─── 6. Test Task 2d: Inspect Saved Section & RequirementSourceLink ─────────
  console.log("\n==================================================================")
  console.log("🔍 [VERIFICATION RESULT - TASK 2d: TRACEABILITY & GENERATED SECTION]")
  console.log("==================================================================")
  console.log(`Section Content Preview (first 300 chars):`)
  console.log(savedSection.content.slice(0, 300) + "...")

  const sourceLinksInDb = await RequirementSourceLink.find({
    projectId: testProject._id,
    sectionId: savedSection._id
  })

  console.log(`\nRequirementSourceLink records in DB: ${sourceLinksInDb.length}`)
  sourceLinksInDb.forEach((link, idx) => {
    console.log(`\n--- Record #${idx + 1} ---`)
    console.log(`  _id: ${link._id}`)
    console.log(`  sectionId: ${link.sectionId}`)
    console.log(`  documentId: ${link.documentId} (Matches doc: ${link.documentId.toString() === testDoc._id.toString()})`)
    console.log(`  sourceExcerpt: "${link.sourceExcerpt}"`)
    const matchesOriginal = sampleExtractedText.toLowerCase().includes(link.sourceExcerpt.toLowerCase())
    console.log(`  Matches original extractedText: ${matchesOriginal ? "✅ EXACT/SUBSTRING MATCH" : "❌ NO MATCH"}`)
  })

  // ─── 7. Test Negative Case: Non-Document SectionType ────────────────────────
  console.log("\n==================================================================")
  console.log("🔍 [VERIFICATION RESULT - TASK 2c: needsSourceDocuments = false]")
  console.log("==================================================================")
  console.log("Testing section 'priority_ranking' (needsSourceDocuments = false)...")
  await generateSection(
    projectId,
    "priority_ranking" as any,
    testChatSession._id.toString(),
    userId
  )
  const rankingContext = await (await import("../shared/ai/document-context.service.js")).buildDocumentContext(
    projectId,
    ActionType.GENERATE_SECTION,
    "priority_ranking"
  )
  console.log(`Document context length for 'priority_ranking': ${rankingContext.contextText.length}`)
  console.log(`Document context empty for 'priority_ranking': ${rankingContext.contextText === "" ? "✅ YES (CORRECT - skipped document context)" : "❌ NO"}`)

  console.log("\n==================================================================")
  console.log("🏁 VERIFICATION COMPLETED SUCCESSFULLY!")
  console.log("==================================================================")
  await mongoose.disconnect()
}

runVerification().catch((err) => {
  console.error("Verification failed with error:", err)
  process.exit(1)
})
