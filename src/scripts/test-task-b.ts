import mongoose from "mongoose"
import dotenv from "dotenv"
import { env } from "../config/env.js"
import { User } from "../modules/user/user.model.js"
import { Project } from "../modules/project/project.model.js"
import { Section } from "../modules/specification/section.model.js"
import { ChatSession } from "../modules/project/chat-session.model.js"
import {
  canAccessPhase,
  canModifySection,
  checkAndAdvancePhase,
  calculateProgress
} from "../modules/specification/phase-gate.service.js"
import {
  saveSection,
  acceptSection,
  generateSection
} from "../modules/specification/specification.service.js"
import {
  getMappedSectionsByPhase
} from "../shared/constants/section-types.js"
import { ApiError } from "../shared/utils/api-error.js"

dotenv.config()

async function testTaskB() {
  console.log("==================================================================")
  console.log("🧪 TESTING TASK B: Phase Gate State Machine & API Enforcement")
  console.log("==================================================================")

  await mongoose.connect(env.MONGO_URI)
  console.log("✅ Connected to MongoDB")

  // 1. Setup Test User & Project
  console.log("\n[1] Setting up fresh test project...")
  let testUser = await User.findOne({ email: "test_phase_gate@flintflow.io" })
  if (!testUser) {
    testUser = await User.create({
      email: "test_phase_gate@flintflow.io",
      password: "hashedpassword123",
      name: "Phase Gate Tester"
    })
  }

  // Clean old test project
  await Project.deleteMany({ name: "Phase Gate Test Project" })
  const testProject = await Project.create({
    name: "Phase Gate Test Project",
    domain: "SaaS AI Specification",
    userId: testUser._id,
    currentPhase: 2,
    progressPercent: 0
  })

  const projectId = testProject._id.toString()
  const userId = testUser._id.toString()

  console.log(`✅ Project created: ID=${projectId}, currentPhase=${testProject.currentPhase}, progressPercent=${testProject.progressPercent}%`)

  // 2. Test Case 1: Attempt to access Phase 3 while Phase 2 is incomplete
  console.log("\n[2] TEST CASE 1: Attempting to access Phase 3 while Phase 2 is incomplete...")
  const accessCheckP3 = await canAccessPhase(projectId, 3)
  console.log(`  canAccessPhase(projectId, 3): allowed=${accessCheckP3.allowed}`)
  console.log(`  Reason: "${accessCheckP3.reason}"`)
  console.log(`  Missing sections count: ${accessCheckP3.missingSections?.length}`)

  if (accessCheckP3.allowed === false && accessCheckP3.missingSections?.length === 7) {
    console.log("  ✅ SUCCESS: Access to Phase 3 is properly blocked by Phase Gate.")
  } else {
    throw new Error("FAIL: Access check to Phase 3 should have been blocked.")
  }

  // Test Case 1b: Attempting to generate a Phase 3 section
  console.log("\n[2b] TEST CASE 1b: Calling generateSection for 'screen_flow' (Phase 3)...")
  const dummyChatSession = await ChatSession.create({
    projectId: testProject._id,
    isActive: true,
    messages: []
  })

  try {
    await generateSection(projectId, "screen_flow", dummyChatSession._id.toString(), userId)
    throw new Error("FAIL: generateSection for Phase 3 should have thrown ApiError 403 PHASE_LOCKED.")
  } catch (err: any) {
    if (err instanceof ApiError && err.statusCode === 403 && err.code === "PHASE_LOCKED") {
      console.log(`  ✅ SUCCESS: generateSection properly rejected with 403 PHASE_LOCKED: "${err.message}"`)
    } else {
      throw err
    }
  }

  // 2c. Test Case 1c: "Nhảy cóc phase" — Attempting to access Phase 4 while project is in Phase 2
  console.log("\n[2c] TEST CASE 1c: 'Nhảy cóc phase' — Calling canAccessPhase(projectId, 4) while currentPhase = 2...")
  const accessCheckJump = await canAccessPhase(projectId, 4)
  console.log(`  canAccessPhase(projectId, 4): allowed=${accessCheckJump.allowed}`)
  console.log(`  Reason: "${accessCheckJump.reason}"`)

  const expectedJumpMessage = "Không thể truy cập Phase 4 khi chưa hoàn thành Phase 2 và Phase 3."
  if (accessCheckJump.allowed === false && accessCheckJump.reason === expectedJumpMessage) {
    console.log("  ✅ SUCCESS: Jump phase attempt rejected with distinct jump-phase message.")
  } else {
    throw new Error(`FAIL: Jump phase check should return allowed=false with jump message, got: "${accessCheckJump.reason}"`)
  }

  // 3. Test Case 2: Progressively accepting Phase 2 sections

  console.log("\n[3] TEST CASE 2: Progressively accepting Phase 2 sections...")
  const phase2Required = getMappedSectionsByPhase(2)
  console.log(`  Phase 2 requires ${phase2Required.length} sections: ${phase2Required.join(", ")}`)

  // Accept first 6 sections (out of 7)
  for (let i = 0; i < phase2Required.length - 1; i++) {
    const type = phase2Required[i]
    await saveSection(
      projectId,
      type,
      `# Content for ${type}`,
      "user",
      "user_edited",
      "accepted"
    )
  }

  let projAfter6 = await Project.findById(projectId)
  console.log(`  After accepting 6/7 sections: currentPhase=${projAfter6?.currentPhase} (Should remain 2)`)
  if (projAfter6?.currentPhase !== 2) {
    throw new Error(`FAIL: currentPhase should still be 2, but got ${projAfter6?.currentPhase}`)
  }

  // Create draft for the 7th section and then accept it
  const lastP2Type = phase2Required[phase2Required.length - 1]
  console.log(`  Creating draft for '${lastP2Type}' and accepting it...`)
  await saveSection(
    projectId,
    lastP2Type,
    `# Draft content for ${lastP2Type}`,
    "user",
    "user_edited",
    "draft"
  )
  const acceptResult = await acceptSection(projectId, lastP2Type, userId)

  let projAfter7 = await Project.findById(projectId)
  console.log(`  After accepting 7/7 sections:`)
  console.log(`    - currentPhase: ${projAfter7?.currentPhase} (Should automatically advance to 3)`)
  console.log(`    - currentStep: "${projAfter7?.currentStep}"`)
  console.log(`    - progressPercent: ${projAfter7?.progressPercent}%`)
  console.log(`    - phaseProgression result: advanced=${acceptResult.phaseProgression.advanced}, oldPhase=${acceptResult.phaseProgression.oldPhase}, newPhase=${acceptResult.phaseProgression.newPhase}`)

  if (projAfter7?.currentPhase === 3 && acceptResult.phaseProgression.advanced === true) {
    console.log("  ✅ SUCCESS: Project automatically advanced to Phase 3 upon full Phase 2 acceptance!")
  } else {
    throw new Error(`FAIL: Project failed to advance to Phase 3. currentPhase=${projAfter7?.currentPhase}`)
  }

  // 4. Test Case 3: Now accessing Phase 3 should succeed
  console.log("\n[4] TEST CASE 3: Verifying Phase 3 access now that Phase 2 is completed...")
  const accessCheckP3Now = await canAccessPhase(projectId, 3)
  console.log(`  canAccessPhase(projectId, 3): allowed=${accessCheckP3Now.allowed}`)

  if (accessCheckP3Now.allowed === true) {
    console.log("  ✅ SUCCESS: Phase 3 is now fully unlocked.")
  } else {
    throw new Error("FAIL: Phase 3 should be unlocked now.")
  }

  // Creating a Phase 3 section
  const p3Section = await saveSection(
    projectId,
    "screen_flow",
    "# Screen Flow Specification Diagram",
    "user",
    "user_edited",
    "draft"
  )
  console.log(`  ✅ Created Phase 3 section 'screen_flow': ID=${p3Section._id}, status='${p3Section.status}'`)

  // 5. Test Case 4: Baseline Lock on Completed Phase 2 Section
  console.log("\n[5] TEST CASE 4: Testing Baseline Lock on accepted Phase 2 section...")
  try {
    await saveSection(
      projectId,
      "vision_problem",
      "# Modified vision after phase completed",
      "user",
      "user_edited",
      "edited_manually"
    )
    throw new Error("FAIL: Modifying accepted Phase 2 section while in Phase 3 should have thrown ApiError 403 SECTION_LOCKED.")
  } catch (err: any) {
    if (err instanceof ApiError && err.statusCode === 403 && err.code === "SECTION_LOCKED") {
      console.log(`  ✅ SUCCESS: Baseline lock blocked direct modification with 403 SECTION_LOCKED: "${err.message}"`)
    } else {
      throw err
    }
  }

  // 6. Test Case 5: Preservation of Old Dependency Checks in Phase 3
  console.log("\n[6] TEST CASE 5: Verifying old dependency check in Phase 3 (generatePriorityRanking without FR)...")
  try {
    // Project is at Phase 3 (Phase Gate passes), but functional_requirements has not been created yet
    await (await import("../modules/specification/specification.service.js")).generatePriorityRanking(projectId, userId)
    throw new Error("FAIL: generatePriorityRanking should have thrown ApiError 400 FR_SECTION_NOT_FOUND.")
  } catch (err: any) {
    if (err instanceof ApiError && err.statusCode === 400 && err.code === "FR_SECTION_NOT_FOUND") {
      console.log(`  ✅ SUCCESS: Old dependency check executed and blocked properly with 400 FR_SECTION_NOT_FOUND: "${err.message}"`)
    } else {
      throw err
    }
  }

  console.log("\n==================================================================")
  console.log("🏁 ALL TASK B TESTS PASSED WITH 100% SUCCESS!")
  console.log("==================================================================")

  // Cleanup test data
  await Section.deleteMany({ projectId: testProject._id })
  await Project.deleteOne({ _id: testProject._id })
  await mongoose.disconnect()
}

testTaskB().catch((err) => {
  console.error("Task B test failed:", err)
  process.exit(1)
})
