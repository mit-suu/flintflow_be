/**
 * seed-from-md.ts
 * ─────────────────────────────────────────────────────────────────
 * Đọc toàn bộ file .md trong assets/prompts/ (frontmatter YAML + nội dung prompt),
 * upsert vào MongoDB collection PromptTemplate của BE.
 *
 * LEGACY (T03): runtime KHÔNG còn đọc PromptTemplate — registry chỉ đọc đĩa.
 * Script chỉ phục vụ assets/prompts (không seed assets/skills), giữ tới T21.
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

import mongoose from "mongoose"
import dotenv from "dotenv"
import { env } from "../config/env.js"
import { getPromptsDir } from "../config/paths.js"
import {
  listPromptAssets,
  getPromptAssetIndex,
  type PromptAsset
} from "../shared/ai/prompt-assets.js"
import { User } from "../modules/user/user.model.js"
import { PromptTemplate } from "../modules/admin/prompt-template.model.js"

dotenv.config()

const PROMPTS_DIR = getPromptsDir()
const isDryRun = process.argv.includes("--dry-run")

// ─── Đọc asset qua loader dùng chung ─────────────────────────────
//
// Việc parse frontmatter + đệ quy thư mục nằm ở src/shared/ai/prompt-assets.ts,
// dùng chung với prompt-registry.service.ts lúc chạy. Giữ hai bản parse riêng là
// cách file .md trên đĩa và template lúc chạy trôi khỏi nhau mà không ai biết.

type ParsedPrompt = PromptAsset

const loadPromptFiles = (): ParsedPrompt[] => listPromptAssets()

/** getPromptAssetIndex() tự nổ nếu có actionType trùng nhau. */
const validateNoDuplicates = (_prompts: ParsedPrompt[]) => {
  getPromptAssetIndex()
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
