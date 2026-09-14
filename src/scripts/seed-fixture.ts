/**
 * T02 — Seed fixture Spine vào Mongo local.
 *
 * Cách dùng:
 *   npm run seed:fixture -- --user <email> [--fixture full|minimal]
 *
 * Ghi chú: T01 (spine model/repository) chưa merge nên script ghi JSON thẳng
 * qua `mongoose.connection.collection("spines")`. Tại M1 đổi sang model của T01
 * và chạy `spineSchema.parse(fixture)` trước khi ghi.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import mongoose from "mongoose"
import { connectDB } from "../config/database.js"
import { User } from "../modules/user/user.model.js"
import { Project } from "../modules/project/project.model.js"
import { ChatSession } from "../modules/project/chat-session.model.js"
import { signAccessToken } from "../shared/auth/jwt.util.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = path.resolve(__dirname, "../../fixtures")

const FIXTURE_FILES = {
  full: "spine-fixture-19-screens.json",
  minimal: "spine-fixture-minimal.json"
} as const

type FixtureKind = keyof typeof FIXTURE_FILES

const parseArgs = (): { userEmail: string; fixture: FixtureKind } => {
  const argv = process.argv.slice(2)
  let userEmail = "fixture@flintflow.io"
  let fixture: FixtureKind = "full"
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--user" && argv[i + 1]) userEmail = argv[++i]
    else if (argv[i] === "--fixture" && argv[i + 1]) {
      const value = argv[++i]
      if (value !== "full" && value !== "minimal") {
        console.error(`--fixture phải là "full" hoặc "minimal", nhận được: ${value}`)
        process.exit(1)
      }
      fixture = value
    }
  }
  return { userEmail, fixture }
}

const seedFixture = async (): Promise<void> => {
  const { userEmail, fixture } = parseArgs()
  const fixturePath = path.join(FIXTURES_DIR, FIXTURE_FILES[fixture])
  const spineData = JSON.parse(fs.readFileSync(fixturePath, "utf8"))

  try {
    await connectDB()
    console.log("🟢 Connected to MongoDB")

    // 1. Tìm hoặc tạo user
    let user = await User.findOne({ email: userEmail.toLowerCase() })
    if (!user) {
      user = await User.create({
        email: userEmail,
        password: "fixture-password-123",
        name: "Fixture User",
        emailVerified: true,
        emailVerifiedAt: new Date()
      })
      console.log(`✅ Created user: ${userEmail}`)
    } else {
      console.log(`✅ Reusing user: ${userEmail}`)
    }

    // 2. Tạo project (mỗi fixture một project riêng, tái dùng nếu đã có)
    const projectName =
      fixture === "full" ? "FlintFlow (Fixture 19 Screens)" : "FlintFlow (Fixture Minimal)"
    let project = await Project.findOne({ userId: user._id, name: projectName })
    if (!project) {
      project = await Project.create({
        userId: user._id,
        name: projectName,
        domain: spineData.project.domain
      })
      console.log(`✅ Created project: ${projectName}`)
    } else {
      console.log(`✅ Reusing project: ${projectName}`)
    }

    // 3. Ghi Spine thẳng vào collection "spines" (thay bằng model T01 tại M1)
    const spines = mongoose.connection.collection("spines")
    await spines.deleteOne({ project_id: project._id })
    await spines.insertOne({
      project_id: project._id,
      ...spineData,
      seeded_at: new Date(),
      fixture_source: FIXTURE_FILES[fixture]
    })
    console.log(`✅ Spine seeded (spine_version=${spineData.spine_version}, fixture=${fixture})`)

    // 4. Tạo chat session pipeline. Model chưa có field is_pipeline (T01) nên
    //    set cờ qua collection để không bị strict schema lược bỏ.
    let session = await ChatSession.findOne({ projectId: project._id, isActive: true })
    if (!session) {
      session = await ChatSession.create({ projectId: project._id, messages: [] })
      console.log("✅ Created pipeline chat session")
    }
    await mongoose.connection
      .collection("chatsessions")
      .updateOne({ _id: session._id as mongoose.Types.ObjectId }, { $set: { is_pipeline: true } })

    // 5. In access token để test API (giống seed-test-uc34.ts)
    const token = signAccessToken({ userId: String(user._id), email: user.email })

    console.log("\n=======================================================")
    console.log("🎉 SEED FIXTURE THÀNH CÔNG")
    console.log("=======================================================")
    console.log(`🔹 User:        ${user.email}`)
    console.log(`🔹 Project ID:  ${project._id}`)
    console.log(`🔹 Fixture:     ${FIXTURE_FILES[fixture]}`)
    console.log(`🔹 Access Token: ${token}`)
    console.log("=======================================================\n")

    process.exit(0)
  } catch (error) {
    console.error("🔴 Lỗi seed fixture:", error)
    process.exit(1)
  }
}

seedFixture()
