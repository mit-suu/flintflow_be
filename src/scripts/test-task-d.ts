import mongoose from "mongoose"
import dotenv from "dotenv"
import { env } from "../config/env.js"
import { User } from "../modules/user/user.model.js"
import { Project } from "../modules/project/project.model.js"
import { Section } from "../modules/specification/section.model.js"
import { VerificationContext } from "../modules/verification/verification-context.model.js"
import {
  computeBasicReadiness,
  getVerificationContext
} from "../modules/verification/verification-context.service.js"
import { saveSection } from "../modules/specification/specification.service.js"
import {
  getMappedSectionsByPhase,
  getAllMappedSections
} from "../shared/constants/section-types.js"

dotenv.config()

async function testTaskD() {
  console.log("==================================================================")
  console.log("🧪 TESTING TASK D: Verification Context Service & Readiness Proxy")
  console.log("==================================================================")

  await mongoose.connect(env.MONGO_URI)
  console.log("✅ Connected to MongoDB")

  // 1. Setup Test User & Project
  console.log("\n[1] Setting up test project for Verification Context...")
  let testUser = await User.findOne({ email: "test_vc@flintflow.io" })
  if (!testUser) {
    testUser = await User.create({
      email: "test_vc@flintflow.io",
      password: "hashedpassword123",
      name: "Verification Context Tester"
    })
  }

  await Project.deleteMany({ name: "VC Test Project" })
  const testProject = await Project.create({
    name: "VC Test Project",
    domain: "Enterprise SaaS",
    userId: testUser._id,
    currentPhase: 2,
    progressPercent: 0
  })

  const projectId = testProject._id.toString()
  const userId = testUser._id.toString()

  // Clean old VC records for this project
  await VerificationContext.deleteMany({ projectId: testProject._id })

  // 2. Initial State Test (0% progress -> BLOCKED)
  console.log("\n[2] TEST CASE 1: Initial state (0 sections accepted)...")
  const initResult = await computeBasicReadiness(projectId)
  console.log(`  readinessScore: ${initResult.summary.readinessScore}% (Expected: 0%)`)
  console.log(`  readinessStatus: '${initResult.summary.readinessStatus}' (Expected: 'BLOCKED')`)
  console.log(`  conflicts: ${JSON.stringify(initResult.verificationContext.conflicts)}`)
  console.log(`  hiddenAssumptions: ${JSON.stringify(initResult.verificationContext.hiddenAssumptions)}`)
  console.log(`  missingInfo: ${JSON.stringify(initResult.verificationContext.missingInfo)}`)
  console.log(`  ambiguities: ${JSON.stringify(initResult.verificationContext.ambiguities)}`)
  console.log(`  followUpQuestions: ${JSON.stringify(initResult.verificationContext.followUpQuestions)}`)

  if (
    initResult.summary.readinessScore === 0 &&
    initResult.summary.readinessStatus === "BLOCKED" &&
    Array.isArray(initResult.verificationContext.conflicts) &&
    initResult.verificationContext.conflicts.length === 0
  ) {
    console.log("  ✅ SUCCESS: Initial VerificationContext computed and saved correctly.")
  } else {
    throw new Error("FAIL: Initial VerificationContext values do not match expected.")
  }

  // 3. In-Progress State Test (Accept Phase 2 -> 31% -> NEEDS_CLARIFICATION)
  console.log("\n[3] TEST CASE 2: In-progress state (Phase 2 accepted = 31%)...")
  const p2Sections = getMappedSectionsByPhase(2)
  for (const type of p2Sections) {
    await saveSection(projectId, type, `# Content for ${type}`, "user", "user_edited", "accepted")
  }

  const p2Result = await computeBasicReadiness(projectId)
  console.log(`  readinessScore: ${p2Result.summary.readinessScore}% (Expected: 31%)`)
  console.log(`  readinessStatus: '${p2Result.summary.readinessStatus}' (Expected: 'NEEDS_CLARIFICATION')`)

  if (
    p2Result.summary.readinessScore === 31 &&
    p2Result.summary.readinessStatus === "NEEDS_CLARIFICATION"
  ) {
    console.log("  ✅ SUCCESS: In-progress readiness updated to 31% / NEEDS_CLARIFICATION.")
  } else {
    throw new Error(`FAIL: Expected 31% / NEEDS_CLARIFICATION, got ${p2Result.summary.readinessScore}% / ${p2Result.summary.readinessStatus}`)
  }

  // 4. Complete State Test (Accept Phase 3 & Phase 4 -> 100% -> READY_TO_BUILD)
  console.log("\n[4] TEST CASE 3: Complete state (All 22 mapped sections accepted = 100%)...")
  const p3Sections = getMappedSectionsByPhase(3)
  for (const type of p3Sections) {
    await saveSection(projectId, type, `# Content for ${type}`, "user", "user_edited", "accepted")
  }
  const p4Sections = getMappedSectionsByPhase(4)
  for (const type of p4Sections) {
    await saveSection(projectId, type, `# Content for ${type}`, "user", "user_edited", "accepted")
  }

  const completeResult = await computeBasicReadiness(projectId)
  console.log(`  readinessScore: ${completeResult.summary.readinessScore}% (Expected: 100%)`)
  console.log(`  readinessStatus: '${completeResult.summary.readinessStatus}' (Expected: 'READY_TO_BUILD')`)

  if (
    completeResult.summary.readinessScore === 100 &&
    completeResult.summary.readinessStatus === "READY_TO_BUILD"
  ) {
    console.log("  ✅ SUCCESS: 100% completion correctly sets READY_TO_BUILD.")
  } else {
    throw new Error(`FAIL: Expected 100% / READY_TO_BUILD, got ${completeResult.summary.readinessScore}% / ${completeResult.summary.readinessStatus}`)
  }

  // 5. VerificationContext Getter Test
  console.log("\n[5] TEST CASE 4: Testing getVerificationContext getter...")
  const fetchedContext = await getVerificationContext(projectId)
  console.log(`  Fetched Document _id: ${fetchedContext._id}`)
  console.log(`  readinessScore: ${fetchedContext.readinessScore}%`)
  console.log(`  readinessStatus: '${fetchedContext.readinessStatus}'`)
  console.log(`  lastComputedAt: ${fetchedContext.lastComputedAt}`)

  if (fetchedContext.readinessScore === 100 && fetchedContext.readinessStatus === "READY_TO_BUILD") {
    console.log("  ✅ SUCCESS: getVerificationContext retrieved persisted record correctly.")
  } else {
    throw new Error("FAIL: getVerificationContext failed to retrieve correct document.")
  }

  console.log("\n==================================================================")
  console.log("🏁 ALL TASK D TESTS PASSED WITH 100% SUCCESS!")
  console.log("==================================================================")

  // Cleanup test data
  await Section.deleteMany({ projectId: testProject._id })
  await VerificationContext.deleteMany({ projectId: testProject._id })
  await Project.deleteOne({ _id: testProject._id })
  await mongoose.disconnect()
}

testTaskD().catch((err) => {
  console.error("Task D test failed:", err)
  process.exit(1)
})
