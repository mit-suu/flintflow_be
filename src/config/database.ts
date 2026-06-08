import mongoose from "mongoose"

export const connectDB = async () => {
  try {
    console.log("URI:", JSON.stringify(process.env.MONGO_URI))
    const mongoURI = process.env.MONGO_URI || ""
    await mongoose.connect(mongoURI)
    console.log("Database connected successfully")
  } catch (error) {
    console.error("Database connection error:", error)
    process.exit(1)
  }
}
