/**
 * T02 — Seed fixture Spine vào Mongo local.
 *
 * Cách dùng:
 *   npm run seed:fixture -- --user <email> [--fixture full|minimal]
 *
 * Spine được validate bằng `spineSchema` (T01) rồi ghi qua model `Spine` với khoá
 * `projectId` — cùng khoá repository/API đọc. Chạy lại là idempotent: Spine và lịch sử
 * `changes` của project bị thay bằng bản fixture (spine_version của fixture).
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { connectDB } from "../config/database.js"
import { User } from "../modules/user/user.model.js"
import { Project } from "../modules/project/project.model.js"
import { ChatSession } from "../modules/project/chat-session.model.js"
import { Spine as SpineModel } from "../modules/spine/spine.model.js"
import { Change as ChangeModel } from "../modules/spine/change.model.js"
import { spineSchema } from "../modules/spine/spine.schema.js"
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
  // Sai hình thì dừng trước khi đụng DB
  const spine = spineSchema.parse(JSON.parse(fs.readFileSync(fixturePath, "utf8")))

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
        domain: spine.project.domain,
        sourceMode: "fpt_template"
      })
      console.log(`✅ Created project: ${projectName}`)
    } else {
      console.log(`✅ Reusing project: ${projectName}`)
    }

    // 3. Ghi Spine qua model T01 (khoá projectId) và bỏ lịch sử change cũ không còn khớp
    await SpineModel.deleteOne({ projectId: project._id })
    await ChangeModel.deleteMany({ projectId: project._id })
    await SpineModel.create({ projectId: project._id, ...spine })
    console.log(`✅ Spine seeded (spine_version=${spine.spine_version}, fixture=${fixture})`)

    // 4. Đúng một chat session pipeline (bất biến 7): ưu tiên session đã giữ cờ
    let session =
      (await ChatSession.findOne({ projectId: project._id, is_pipeline: true })) ??
      (await ChatSession.findOne({ projectId: project._id, isActive: true }))
    if (!session) {
      session = await ChatSession.create({ projectId: project._id, messages: [] })
      console.log("✅ Created pipeline chat session")
    }
    await ChatSession.updateOne({ _id: session._id }, { $set: { is_pipeline: true } })

    // 5. In access token để test API
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
