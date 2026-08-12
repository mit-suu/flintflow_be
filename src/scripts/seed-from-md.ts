/**
 * seed-from-md.ts
 * ─────────────────────────────────────────────────────────────────
 * Đọc toàn bộ file .md trong ./prompts/ (frontmatter YAML + nội dung prompt),
 * upsert vào MongoDB collection PromptTemplate của BE.
 *
 * Cách chạy:
 *   npx tsx src/scripts/seed-from-md.ts             # seed thật vào DB
 *   npx tsx src/scripts/seed-from-md.ts --dry-run   # xem kết quả parse, KHÔNG ghi DB
 *
 * Mục tiêu thiết kế:
 *   - Người không rành code chỉ cần mở file .md trong prompts/, sửa nội dung prompt
 *     hoặc đổi provider/model trong frontmatter, rồi chạy lại script — không cần đụng code.
 *   - Mỗi file .md = 1 actionType. Tên file không quan trọng, actionType trong frontmatter mới quan trọng.
 *   - Thêm actionType mới: tạo thêm file .md mới → chạy lại script (không cần sửa script này).
 *
 * Format frontmatter bắt buộc (xem prompts/README.md để biết chi tiết):
 *   actionType, provider, aiModel, maxTokens, temperature, isActive
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import mongoose from "mongoose"
import dotenv from "dotenv"
import matter from "gray-matter"
import { env } from "../config/env.js"
import { User } from "../modules/user/user.model.js"
import { PromptTemplate } from "../modules/admin/prompt-template.model.js"

dotenv.config()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROMPTS_DIR = path.join(__dirname, "prompts")
const isDryRun = process.argv.includes("--dry-run")

// ─── Types ───────────────────────────────────────────────────────

type ParsedPrompt = {
  file: string
  actionType: string
  provider: string
  aiModel: string
  maxTokens: number
  temperature: number
  isActive: boolean
  description?: string
  template: string
}

// ─── Bắt buộc các field frontmatter phải có ──────────────────────

const REQUIRED_FIELDS = ["actionType", "provider", "aiModel", "maxTokens", "temperature"]

// ─── Đọc & parse tất cả file .md trong prompts/ ──────────────────

function loadPromptFiles(): ParsedPrompt[] {
  if (!fs.existsSync(PROMPTS_DIR)) {
    throw new Error(`Không tìm thấy thư mục prompts/: ${PROMPTS_DIR}`)
  }

  const files = fs.readdirSync(PROMPTS_DIR).filter((f) => f.endsWith(".md") && f !== "README.md")
  if (files.length === 0) {
    throw new Error(`Không có file .md nào trong ${PROMPTS_DIR}`)
  }

  const results: ParsedPrompt[] = []

  for (const file of files) {
    const fullPath = path.join(PROMPTS_DIR, file)
    const raw = fs.readFileSync(fullPath, "utf-8")
    const { data, content } = matter(raw)

    // Validate required fields
    const missing = REQUIRED_FIELDS.filter((f) => data[f] === undefined || data[f] === null)
    if (missing.length > 0) {
      throw new Error(`[${file}] Thiếu field frontmatter bắt buộc: ${missing.join(", ")}`)
    }

    const template = content.trim()
    if (!template) {
      throw new Error(`[${file}] Nội dung prompt (template) không được để trống.`)
    }

    results.push({
      file,
      actionType: String(data.actionType),
      provider: String(data.provider),
      aiModel: String(data.aiModel),
      maxTokens: Number(data.maxTokens),
      temperature: Number(data.temperature),
      isActive: data.isActive !== false,
      description: data.description ? String(data.description) : undefined,
      template,
    })
  }

  return results
}

// ─── Kiểm tra không có actionType trùng nhau ─────────────────────

function validateNoDuplicates(prompts: ParsedPrompt[]) {
  const seen = new Map<string, string>()
  for (const p of prompts) {
    if (seen.has(p.actionType)) {
      throw new Error(
        `actionType trùng lặp: "${p.actionType}" xuất hiện ở cả "${seen.get(p.actionType)}" và "${p.file}"`
      )
    }
    seen.set(p.actionType, p.file)
  }
}

// ─── Main ─────────────────────────────────────────────────────────

async function main() {
  console.log(`\n📂 Đọc prompt templates từ: ${PROMPTS_DIR}\n`)

  const prompts = loadPromptFiles()
  validateNoDuplicates(prompts)

  // In bảng tổng hợp
  console.log(`✅ Parse thành công ${prompts.length} file:\n`)
  console.log(
    "   " +
      ["File".padEnd(26), "actionType".padEnd(20), "Provider/Model".padEnd(32), "isActive"].join(" | ")
  )
  console.log("   " + "-".repeat(90))
  for (const p of prompts) {
    console.log(
      "   " +
        [
          p.file.padEnd(26),
          p.actionType.padEnd(20),
          `${p.provider}/${p.aiModel}`.padEnd(32),
          p.isActive ? "✅ true" : "❌ false",
        ].join(" | ")
    )
  }
  console.log("")

  // Dry-run: chỉ in, không ghi DB
  if (isDryRun) {
    console.log("🔍 Dry-run mode — KHÔNG ghi vào DB. Bỏ --dry-run để seed thật.\n")
    return
  }

  // Kết nối DB
  console.log("🔌 Kết nối MongoDB...")
  await mongoose.connect(env.MONGO_URI)
  console.log("✅ Đã kết nối.\n")

  // Tìm admin user để gán updatedBy
  let adminUser = await User.findOne({ role: "admin" })
  if (!adminUser) adminUser = await User.findOne({})
  if (!adminUser) {
    throw new Error("Không tìm thấy user nào trong DB. Hãy tạo user/admin trước.")
  }
  console.log(`👤 Dùng user ID: ${adminUser._id}\n`)

  let created = 0
  let updated = 0
  let skipped = 0

  for (const p of prompts) {
    // Tìm doc mới nhất theo actionType
    const latestDoc = await PromptTemplate.findOne({ actionType: p.actionType }).sort({ version: -1 })

    if (!latestDoc) {
      // Tạo mới version 1
      await PromptTemplate.create({
        actionType: p.actionType,
        template: p.template,
        provider: p.provider,
        aiModel: p.aiModel,
        maxTokens: p.maxTokens,
        temperature: p.temperature,
        version: 1,
        isActive: p.isActive,
        updatedBy: adminUser._id,
      })
      created++
      console.log(`   🆕 Tạo mới  : ${p.actionType} (v1)`)
    } else {
      const hasChanged =
        latestDoc.template.trim() !== p.template.trim() ||
        latestDoc.provider !== p.provider ||
        latestDoc.aiModel !== p.aiModel ||
        latestDoc.maxTokens !== p.maxTokens ||
        latestDoc.temperature !== p.temperature ||
        latestDoc.isActive !== p.isActive

      if (hasChanged) {
        // Tạo version mới, deactivate tất cả version cũ
        await PromptTemplate.updateMany({ actionType: p.actionType }, { isActive: false })
        const nextVersion = latestDoc.version + 1
        await PromptTemplate.create({
          actionType: p.actionType,
          template: p.template,
          provider: p.provider,
          aiModel: p.aiModel,
          maxTokens: p.maxTokens,
          temperature: p.temperature,
          version: nextVersion,
          isActive: p.isActive,
          updatedBy: adminUser._id,
        })
        updated++
        console.log(`   🔄 Cập nhật : ${p.actionType} (v${latestDoc.version} → v${nextVersion})`)
      } else {
        skipped++
        console.log(`   ⏭️  Bỏ qua   : ${p.actionType} (v${latestDoc.version}, không thay đổi)`)
      }
    }
  }

  console.log(`\n✅ Xong! Tạo mới: ${created} | Cập nhật: ${updated} | Bỏ qua: ${skipped}\n`)

  await mongoose.disconnect()
}

main().catch((err) => {
  console.error("\n❌ Lỗi:", err.message)
  process.exit(1)
})
