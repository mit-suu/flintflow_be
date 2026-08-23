import mongoose from "mongoose"
import dotenv from "dotenv"
import { env } from "../config/env.js"
import { User } from "../modules/user/user.model.js"
import { Project } from "../modules/project/project.model.js"
import { Section } from "../modules/specification/section.model.js"
import {
  calculateProgress,
  getProjectProgressBreakdown
} from "../modules/specification/phase-gate.service.js"
import {
  saveSection,
  acceptSection
} from "../modules/specification/specification.service.js"
import {
  getMappedSectionsByPhase,
  getAllMappedSections,
  SECTION_METADATA
} from "../shared/constants/section-types.js"

dotenv.config()

async function testTaskC() {
  console.log("==================================================================")
  console.log("🧪 TESTING TASK C: Automatic Progress Percent & Phase Breakdown")
  console.log("==================================================================")

  await mongoose.connect(env.MONGO_URI)
  console.log("✅ Connected to MongoDB")

  // 1. Setup Test User & Project
  console.log("\n[1] Setting up test project for Progress Calculation...")
  let testUser = await User.findOne({ email: "test_progress@flintflow.io" })
  if (!testUser) {
    testUser = await User.create({
      email: "test_progress@flintflow.io",
      password: "hashedpassword123",
      name: "Progress Tester"
    })
  }

  await Project.deleteMany({ name: "Progress Test Project" })
  const testProject = await Project.create({
    name: "Progress Test Project",
    domain: "Automated Specification Platform",
    userId: testUser._id,
    currentPhase: 2,
    progressPercent: 0
  })

  const projectId = testProject._id.toString()
  const userId = testUser._id.toString()

  const allMapped = getAllMappedSections()
  console.log(`Total mappedToTemplate sections in system: ${allMapped.length} (Expected: 22)`)

  // 2. Initial state
  console.log("\n[2] Checking initial progress state (0 sections accepted)...")
  let initialBreakdown = await getProjectProgressBreakdown(projectId)
  console.log(`  Initial Overall Progress: ${initialBreakdown.overallProgress}%`)
  console.log(`  Phase 2: ${initialBreakdown.phases.phase2.completed}/${initialBreakdown.phases.phase2.total} (${initialBreakdown.phases.phase2.percent}%) - Unlocked: ${initialBreakdown.phases.phase2.isUnlocked}`)
  console.log(`  Phase 3: ${initialBreakdown.phases.phase3.completed}/${initialBreakdown.phases.phase3.total} (${initialBreakdown.phases.phase3.percent}%) - Unlocked: ${initialBreakdown.phases.phase3.isUnlocked}`)
  console.log(`  Phase 4: ${initialBreakdown.phases.phase4.completed}/${initialBreakdown.phases.phase4.total} (${initialBreakdown.phases.phase4.percent}%) - Unlocked: ${initialBreakdown.phases.phase4.isUnlocked}`)

  if (initialBreakdown.overallProgress !== 0) {
    throw new Error("FAIL: Initial progress should be 0%")
  }

  // 3. Accept 1 section in Phase 2
  console.log("\n[3] Accepting 1 section in Phase 2 ('vision_problem')...")
  await saveSection(projectId, "vision_problem", "# Vision statement", "user", "user_edited", "draft")
  await acceptSection(projectId, "vision_problem", userId)

  const proj1 = await Project.findById(projectId)
  console.log(`  Project progressPercent after 1 section: ${proj1?.progressPercent}% (Expected: Math.floor(1/22*100) = 4%)`)
  if (proj1?.progressPercent !== 4) {
    throw new Error(`FAIL: Expected 4% after 1 section, got ${proj1?.progressPercent}%`)
  }

  // 4. Accept remaining 6 sections of Phase 2 (Total 7/22 = 31%)
  console.log("\n[4] Accepting all remaining Phase 2 sections...")
  const p2Sections = getMappedSectionsByPhase(2)
  for (const type of p2Sections) {
    if (type === "vision_problem") continue
    await saveSection(projectId, type, `# Content for ${type}`, "user", "user_edited", "accepted")
  }

  const projP2Done = await Project.findById(projectId)
  console.log(`  After Phase 2 complete (7 sections):`)
  console.log(`    - currentPhase: ${projP2Done?.currentPhase} (Expected: 3)`)
  console.log(`    - progressPercent: ${projP2Done?.progressPercent}% (Expected: Math.floor(7/22*100) = 31%)`)

  if (projP2Done?.progressPercent !== 31 || projP2Done?.currentPhase !== 3) {
    throw new Error(`FAIL: Expected 31% and currentPhase=3, got ${projP2Done?.progressPercent}% and ${projP2Done?.currentPhase}`)
  }

  // 5. Accept all 8 mapped sections of Phase 3 (Total 15/22 = 68%)
  console.log("\n[5] Accepting all 8 mapped sections of Phase 3...")
  const p3Sections = getMappedSectionsByPhase(3)
  for (const type of p3Sections) {
    await saveSection(projectId, type, `# Content for ${type}`, "user", "user_edited", "accepted")
  }

  const projP3Done = await Project.findById(projectId)
  console.log(`  After Phase 3 complete (15 sections total):`)
  console.log(`    - currentPhase: ${projP3Done?.currentPhase} (Expected: 4)`)
  console.log(`    - progressPercent: ${projP3Done?.progressPercent}% (Expected: Math.floor(15/22*100) = 68%)`)

  if (projP3Done?.progressPercent !== 68 || projP3Done?.currentPhase !== 4) {
    throw new Error(`FAIL: Expected 68% and currentPhase=4, got ${projP3Done?.progressPercent}% and ${projP3Done?.currentPhase}`)
  }

  // Also create an internal-only section ('priority_ranking') and verify it does NOT increase denominator or count
  console.log("\n[5b] Creating internal-only section 'priority_ranking' (mappedToTemplate: false)...")
  await saveSection(projectId, "priority_ranking", [{ feature: "Test", priority: "Must-have" }], "user", "user_edited", "accepted")
  const projAfterInternal = await Project.findById(projectId)
  console.log(`  After internal-only section accepted: progressPercent=${projAfterInternal?.progressPercent}% (Should stay 68%)`)
  if (projAfterInternal?.progressPercent !== 68) {
    throw new Error("FAIL: Internal-only section should not affect progressPercent!")
  }

  // 6. Accept all 7 mapped sections of Phase 4 (Total 22/22 = 100%)
  console.log("\n[6] Accepting all 7 mapped sections of Phase 4...")
  const p4Sections = getMappedSectionsByPhase(4)
  for (const type of p4Sections) {
    await saveSection(projectId, type, `# Content for ${type}`, "user", "user_edited", "accepted")
  }

  const projP4Done = await Project.findById(projectId)
  console.log(`  After Phase 4 complete (22 sections total):`)
  console.log(`    - currentPhase: ${projP4Done?.currentPhase} (Expected: 4)`)
  console.log(`    - progressPercent: ${projP4Done?.progressPercent}% (Expected: 100%)`)

  if (projP4Done?.progressPercent !== 100) {
    throw new Error(`FAIL: Expected 100%, got ${projP4Done?.progressPercent}%`)
  }

  // 7. Verify full breakdown output (UC 7.1 & UC 7.2)
  console.log("\n[7] Verifying full Detailed Section Status Breakdown (UC 7.1)...")
  const finalBreakdown = await getProjectProgressBreakdown(projectId)
  console.log(`  Overall Progress: ${finalBreakdown.overallProgress}%`)
  console.log(`  Total Mapped Sections: ${finalBreakdown.totalMappedSections}`)
  console.log(`  Total Accepted Mapped: ${finalBreakdown.totalAcceptedMappedSections}`)
  console.log(`  Phase 2 Breakdown: ${finalBreakdown.phases.phase2.completed}/${finalBreakdown.phases.phase2.total} (${finalBreakdown.phases.phase2.percent}%) | Completed: ${finalBreakdown.phases.phase2.isCompleted}`)
  console.log(`  Phase 3 Breakdown: ${finalBreakdown.phases.phase3.completed}/${finalBreakdown.phases.phase3.total} (${finalBreakdown.phases.phase3.percent}%) | Completed: ${finalBreakdown.phases.phase3.isCompleted}`)
  console.log(`  Phase 4 Breakdown: ${finalBreakdown.phases.phase4.completed}/${finalBreakdown.phases.phase4.total} (${finalBreakdown.phases.phase4.percent}%) | Completed: ${finalBreakdown.phases.phase4.isCompleted}`)

  console.log("\n==================================================================")
  console.log("🏁 ALL TASK C TESTS PASSED WITH 100% SUCCESS!")
  console.log("==================================================================")

  // Cleanup test data
  await Section.deleteMany({ projectId: testProject._id })
  await Project.deleteOne({ _id: testProject._id })
  await mongoose.disconnect()
}

testTaskC().catch((err) => {
  console.error("Task C test failed:", err)
  process.exit(1)
})
