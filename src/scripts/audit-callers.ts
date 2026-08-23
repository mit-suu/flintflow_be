import fs from "fs"
import path from "path"
import mongoose from "mongoose"
import dotenv from "dotenv"
import { env } from "../config/env.js"
import { ActionType } from "../shared/ai/ai-action.types.js"
import { PromptTemplate } from "../modules/admin/prompt-template.model.js"
import { getPromptTemplate } from "../shared/ai/prompt-registry.service.js"

dotenv.config()

function searchFiles(dir: string, fileList: string[] = []): string[] {
  const files = fs.readdirSync(dir)
  for (const file of files) {
    const fullPath = path.join(dir, file)
    if (fs.statSync(fullPath).isDirectory()) {
      if (file !== "node_modules" && file !== "dist") {
        searchFiles(fullPath, fileList)
      }
    } else if (file.endsWith(".ts")) {
      fileList.push(fullPath)
    }
  }
  return fileList
}

async function runCallerAudit() {
  await mongoose.connect(env.MONGO_URI)

  const allTsFiles = searchFiles(path.resolve("src"))
  console.log(`Auditing across ${allTsFiles.length} TS files in src/...`)

  console.log("\n==========================================================================")
  console.log("1. AUDIT OF ALL 14 ACTION TYPES (DB vs DEFAULT, PLACEHOLDERS, CALL SITES)")
  console.log("==========================================================================")

  for (const actionKey of Object.values(ActionType)) {
    console.log(`\n--------------------------------------------------------------------------`)
    console.log(`ACTION: ${actionKey}`)

    // Check DB
    const dbActive = await PromptTemplate.findOne({ actionType: actionKey, isActive: true }).lean()
    const templateObj = await getPromptTemplate(actionKey)

    console.log(`  Source: ${dbActive ? "DATABASE (active)" : "DEFAULT_TEMPLATES FALLBACK (No active DB record)"}`)
    console.log(`  Provider/Model: ${templateObj.providerConfig.provider} / ${templateObj.providerConfig.model}`)
    console.log(`  MaxTokens: ${templateObj.providerConfig.maxTokens}, Temp: ${templateObj.providerConfig.temperature}`)

    // Extract placeholders
    const placeholders = [...templateObj.template.matchAll(/{{\s*([a-zA-Z0-9_]+)\s*}}/g)].map(m => m[1])
    console.log(`  Placeholders in Template: [${[...new Set(placeholders)].join(", ")}]`)

    // Find callers in codebase
    const matches: string[] = []
    for (const f of allTsFiles) {
      if (f.includes("prompt-registry.service.ts") || f.includes("audit-") || f.includes("test-")) continue
      const content = fs.readFileSync(f, "utf-8")
      if (content.includes(`"${actionKey}"`) || content.includes(`ActionType.${Object.keys(ActionType).find(k => (ActionType as any)[k] === actionKey)}`)) {
        matches.push(path.relative(process.cwd(), f))
      }
    }
    console.log(`  Callers/References in src: ${matches.length > 0 ? matches.join(", ") : "NONE (No active caller in src)"}`)
  }

  await mongoose.disconnect()
}

runCallerAudit().catch(console.error)
