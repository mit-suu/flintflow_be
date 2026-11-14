import mongoose from "mongoose"
import dotenv from "dotenv"
import { env } from "../config/env.js"
import { AiActionLog } from "../modules/admin/ai-action-log.model.js"
import { ActionType } from "../shared/ai/ai-action.types.js"
import { getActionCost } from "../shared/ai/credit-reservation.service.js"

dotenv.config()

// Prompt và bảng giá đều cấu hình trên server (không còn lưu trong DB)
async function auditDB() {
  await mongoose.connect(env.MONGO_URI)
  console.log("=== DB AUDIT: AI ACTION LOGS ===")
  const logCount = await AiActionLog.countDocuments({})
  console.log(`Found ${logCount} AI action logs in MongoDB.`)

  console.log("\n=== SERVER CONFIG: ACTION COSTS ===")
  for (const actionType of Object.values(ActionType)) {
    console.log(`${actionType}: ${await getActionCost(actionType)}`)
  }

  await mongoose.disconnect()
}

auditDB().catch(console.error)
