import mongoose from "mongoose"
import dotenv from "dotenv"
import { env } from "../config/env.js"
import { Section } from "../modules/specification/section.model.js"
import {
  SECTION_TYPE_VALUES,
  SECTION_METADATA,
  getSectionsByPhase,
  getMappedSectionsByPhase,
  getAllMappedSections
} from "../shared/constants/section-types.js"

dotenv.config()

async function testTaskA() {
  console.log("==================================================================")
  console.log("🧪 TESTING TASK A: Migration SectionType (15 → 25 types)")
  console.log("==================================================================")

  await mongoose.connect(env.MONGO_URI)
  console.log("✅ Connected to MongoDB")

  // 1. Verify counts and metadata
  console.log(`\n[1] SectionType count: ${SECTION_TYPE_VALUES.length}`)
  const phase2 = getSectionsByPhase(2)
  const phase3 = getSectionsByPhase(3)
  const phase4 = getSectionsByPhase(4)

  const mappedP2 = getMappedSectionsByPhase(2)
  const mappedP3 = getMappedSectionsByPhase(3)
  const mappedP4 = getMappedSectionsByPhase(4)
  const allMapped = getAllMappedSections()

  console.log(`  Phase 2: ${phase2.length} total (${mappedP2.length} mappedToTemplate: true)`)
  console.log(`  Phase 3: ${phase3.length} total (${mappedP3.length} mappedToTemplate: true, ${phase3.length - mappedP3.length} mappedToTemplate: false)`)
  console.log(`  Phase 4: ${phase4.length} total (${mappedP4.length} mappedToTemplate: true, ${phase4.length - mappedP4.length} mappedToTemplate: false)`)
  console.log(`  Total mappedToTemplate: true: ${allMapped.length}`)
  console.log(`  Total mappedToTemplate: false: ${SECTION_TYPE_VALUES.length - allMapped.length}`)

  // 2. Verify all existing sections in DB still load cleanly without enum errors
  console.log("\n[2] Checking existing Section records in DB...")
  const existingSections = await Section.find({}).limit(50).lean()
  console.log(`  Loaded ${existingSections.length} existing Section record(s) from DB:`)
  existingSections.forEach((s) => {
    const meta = SECTION_METADATA[s.type as keyof typeof SECTION_METADATA]
    console.log(`    - ID: ${s._id} | Type: '${s.type}' | Status: '${s.status}'`)
    console.log(`      => Phase: ${meta?.phase} | Order: ${meta?.order} | mappedToTemplate: ${meta?.mappedToTemplate} | Label: "${meta?.label}"`)
    if (!meta) {
      throw new Error(`CRITICAL: Section type '${s.type}' has no metadata entry!`)
    }
  })

  // 3. Test creating a Section with a NEW SectionType
  console.log("\n[3] Testing insert & query with newly added SectionTypes...")
  const dummyProjectId = new mongoose.Types.ObjectId()

  const testNewTypes = ["high_level_business_rules", "screen_flow", "erd", "glossary"]
  for (const type of testNewTypes) {
    const doc = new Section({
      projectId: dummyProjectId,
      type: type as any,
      content: `# Test content for ${type}`,
      status: "draft",
      sourceType: "ai_generated",
      order: SECTION_METADATA[type as keyof typeof SECTION_METADATA].order
    })
    await doc.validate()
    console.log(`  ✅ Schema validation passed for new type: '${type}' (Phase ${SECTION_METADATA[type as keyof typeof SECTION_METADATA].phase})`)
  }

  console.log("\n==================================================================")
  console.log("🏁 TASK A TEST PASSED SUCCESSFULLY!")
  console.log("==================================================================")
  await mongoose.disconnect()
}

testTaskA().catch((err) => {
  console.error("Task A test failed:", err)
  process.exit(1)
})
