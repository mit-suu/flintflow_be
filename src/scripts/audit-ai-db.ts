import mongoose from "mongoose"
import dotenv from "dotenv"
import { env } from "../config/env.js"
import { PromptTemplate } from "../modules/admin/prompt-template.model.js"
import { PricingConfig } from "../modules/admin/pricing-config.model.js"

dotenv.config()

async function auditDB() {
  await mongoose.connect(env.MONGO_URI)
  console.log("=== DB AUDIT: PROMPT TEMPLATES ===")
  const templates = await PromptTemplate.find({}).lean()
  console.log(`Found ${templates.length} templates in MongoDB:`)
  for (const t of templates) {
    console.log(JSON.stringify({
      actionType: t.actionType,
      name: (t as any).name,
      provider: t.provider,
      aiModel: t.aiModel,
      maxTokens: t.maxTokens,
      temperature: t.temperature,
      isActive: t.isActive,
      templateExcerpt: (t.template || "").substring(0, 80) + "..."
    }, null, 2))
  }

  console.log("\n=== DB AUDIT: PRICING CONFIG ===")
  const pricing = await PricingConfig.find({}).lean()
  console.log(`Found ${pricing.length} pricing configs in MongoDB:`)
  for (const p of pricing) {
    console.log(JSON.stringify(p, null, 2))
  }

  await mongoose.disconnect()
}

auditDB().catch(console.error)
