import mongoose from "mongoose"
import dotenv from "dotenv"
import { env } from "../config/env.js"
import { PricingConfig } from "../modules/admin/pricing-config.model.js"

dotenv.config()

// Prompt không còn trong DB (registry chỉ đọc đĩa) — script chỉ còn soát bảng giá đang lưu
async function auditDB() {
  await mongoose.connect(env.MONGO_URI)
  console.log("=== DB AUDIT: PRICING CONFIG ===")
  const pricing = await PricingConfig.find({}).lean()
  console.log(`Found ${pricing.length} pricing configs in MongoDB:`)
  for (const p of pricing) {
    console.log(JSON.stringify(p, null, 2))
  }

  await mongoose.disconnect()
}

auditDB().catch(console.error)
