import mongoose from "mongoose"
import { env } from "./env.js"
import { User } from "../modules/user/user.model.js"

export const initReplicaSet = async (): Promise<void> => {
  try {
    const adminDb = mongoose.connection.db?.admin()
    if (adminDb) {
      await adminDb.command({ replSetInitiate: {} })
      console.log("[InitReplicaSet] Replica Set initialized successfully")
    }
  } catch (error: any) {
    // Ignore if already initialized or not configured with --replSet
  }
}

export const initAdmin = async (): Promise<void> => {
  try {
    const adminEmail = env.ADMIN_EMAIL
    const adminPassword = env.ADMIN_PASSWORD

    if (!adminEmail || !adminPassword) {
      console.log("[InitAdmin] Skipped: ADMIN_EMAIL or ADMIN_PASSWORD not configured")
      return
    }

    const existingAdmin = await User.findOne({ email: adminEmail.toLowerCase() })

    if (!existingAdmin) {
      await User.create({
        email: adminEmail,
        password: adminPassword,
        role: "admin",
        name: "System Admin",
        authProvider: "local",
        emailVerified: true,
        emailVerifiedAt: new Date()
      })
      console.log(`[InitAdmin] Admin account created successfully: ${adminEmail}`)
    } else {
      console.log(`[InitAdmin] Admin account already exists: ${adminEmail}`)
    }
  } catch (error) {
    console.error("[InitAdmin] Failed to initialize admin account:", error)
  }
}

export const connectDB = async (): Promise<void> => {
  try {
    await mongoose.connect(env.MONGO_URI)
    console.log("Database connected successfully")
    await initReplicaSet()
    await initAdmin()
  } catch (error) {
    console.error("Database connection error:", error)
    process.exit(1)
  }
}
