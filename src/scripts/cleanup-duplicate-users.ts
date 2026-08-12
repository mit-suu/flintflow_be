import mongoose from "mongoose"
import dotenv from "dotenv"
import { env } from "../config/env.js"
import { User } from "../modules/user/user.model.js"
import { Session } from "../shared/auth/session.model.js"
import { CreditWallet } from "../modules/credits/credit-wallet.model.js"
import { CreditTransaction } from "../modules/credits/credit-transaction.model.js"
import { AiActionLog } from "../modules/admin/ai-action-log.model.js"

dotenv.config()

export const cleanupDuplicateUsers = async () => {
  try {
    console.log("[Cleanup] Connecting to MongoDB...")
    await mongoose.connect(env.MONGO_URI)

    const allUsers = await User.find({}).sort({ createdAt: 1 })
    console.log(`[Cleanup] Total users in DB: ${allUsers.length}`)

    const emailMap = new Map<string, any[]>()

    for (const user of allUsers) {
      const normEmail = (user.email || "").toLowerCase().trim()
      if (!emailMap.has(normEmail)) {
        emailMap.set(normEmail, [])
      }
      emailMap.get(normEmail)!.push(user)
    }

    let duplicateCount = 0

    for (const [normEmail, users] of emailMap.entries()) {
      if (users.length > 1) {
        duplicateCount++
        console.log(`[Cleanup] Found ${users.length} duplicate accounts for email: '${normEmail}'`)

        // Primary user (keep the earliest created or local account with password)
        const primaryUser = users.find((u) => u.passwordHash) || users[0]
        const secondaryUsers = users.filter((u) => u._id.toString() !== primaryUser._id.toString())

        for (const sec of secondaryUsers) {
          console.log(`[Cleanup] Merging secondary user ID ${sec._id} into primary user ID ${primaryUser._id}...`)

          // Merge fields into primary
          if (sec.googleId && !primaryUser.googleId) {
            primaryUser.googleId = sec.googleId
          }
          if (sec.emailVerified && !primaryUser.emailVerified) {
            primaryUser.emailVerified = true
            primaryUser.emailVerifiedAt = sec.emailVerifiedAt || new Date()
          }
          if (sec.role === "admin" && primaryUser.role !== "admin") {
            primaryUser.role = "admin"
          }
          if (!primaryUser.name && sec.name) {
            primaryUser.name = sec.name
          }

          // Re-point related collections
          await Session.updateMany({ userId: sec._id }, { userId: primaryUser._id })
          await CreditTransaction.updateMany({ userId: sec._id }, { userId: primaryUser._id })
          await AiActionLog.updateMany({ userId: sec._id }, { userId: primaryUser._id })

          // Delete duplicate user
          await User.findByIdAndDelete(sec._id)
          // Delete duplicate wallet if any
          await CreditWallet.deleteMany({ userId: sec._id })
        }

        await primaryUser.save()
        console.log(`[Cleanup] ✅ Merged & cleaned up '${normEmail}' into user ID ${primaryUser._id}`)
      }
    }

    // Ensure Mongoose Unique Index on email
    try {
      await User.syncIndexes()
      console.log("[Cleanup] ✅ User model indexes synchronized successfully.")
    } catch (idxErr) {
      console.warn("[Cleanup] Index sync warning:", idxErr)
    }

    if (duplicateCount === 0) {
      console.log("[Cleanup] No duplicate users found.")
    }
  } catch (error) {
    console.error("[Cleanup] Error cleaning up duplicate users:", error)
  } finally {
    await mongoose.disconnect()
  }
}

if (process.argv[1]?.includes("cleanup-duplicate-users")) {
  cleanupDuplicateUsers()
}
