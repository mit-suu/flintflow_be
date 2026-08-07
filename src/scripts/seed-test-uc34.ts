import mongoose from "mongoose"
import { env } from "../config/env.js"
import { connectDB } from "../config/database.js"
import { User } from "../modules/user/user.model.js"
import { Project } from "../modules/project/project.model.js"
import { Section } from "../modules/specification/section.model.js"
import { signAccessToken } from "../shared/auth/jwt.util.js"

const seedTestData = async () => {
  try {
    await connectDB()
    console.log("🟢 Connected to MongoDB")

    // 1. Tạo User test
    let user = await User.findOne({ email: "test_uc34_35@flintflow.io" })
    if (!user) {
      user = await User.create({
        email: "test_uc34_35@flintflow.io",
        password: "hashedpassword123",
        name: "Test User",
        isEmailVerified: true
      })
    }
    console.log(`✅ Test User ID: ${user._id}`)

    // 2. Tạo Project test
    let project = await Project.findOne({ name: "FlintFlow E-Commerce" })
    if (!project) {
      project = await Project.create({
        userId: user._id,
        name: "FlintFlow E-Commerce",
        domain: "E-commerce platform with AI integration"
      })
    }
    console.log(`✅ Test Project ID: ${project._id}`)

    // 3. Tạo Section: Business Goals (Context)
    await Section.findOneAndUpdate(
      { projectId: project._id, type: "business_goals" },
      {
        content: "Tăng doanh số bán hàng online lên 200%. Giảm thiểu rủi ro gian lận thanh toán.",
        status: "accepted"
      },
      { upsert: true }
    )

    // 4. Tạo Section: Functional Requirements (Cần cho UC34)
    await Section.findOneAndUpdate(
      { projectId: project._id, type: "functional_requirements" },
      {
        content: {
          title: "FlintFlow E-commerce",
          functionalRequirements: [
            {
              id: "FR-01",
              module: "User Management",
              featureName: "Đăng ký và Đăng nhập",
              description: "Người dùng có thể đăng ký tài khoản và đăng nhập bằng Email/Password",
              priority: null
            },
            {
              id: "FR-02",
              module: "Product Catalog",
              featureName: "Gợi ý sản phẩm bằng AI",
              description: "Hệ thống tự động gợi ý sản phẩm dựa trên lịch sử mua hàng.",
              priority: null
            },
            {
              id: "FR-03",
              module: "Checkout",
              featureName: "Thanh toán qua Crypto",
              description: "Hỗ trợ thanh toán bằng Bitcoin và Ethereum.",
              priority: null
            }
          ]
        },
        status: "draft"
      },
      { upsert: true }
    )
    console.log(`✅ Created Mock Sections (Context & Functional Requirements)`)

    // 5. Sinh JWT Token để test
    const token = signAccessToken({ userId: user._id.toString(), email: user.email })
    
    console.log("\n=======================================================")
    console.log("🎉 SEED THÀNH CÔNG! HÃY SỬ DỤNG THÔNG TIN SAU ĐỂ TEST:")
    console.log("=======================================================")
    console.log(`🔹 Project ID: ${project._id}`)
    console.log(`🔹 Access Token: ${token}`)
    console.log("=======================================================\n")
    console.log("Bạn có thể copy Token trên, vào http://localhost:5000/api-docs, bấm nút 'Authorize' và dán vào.")
    console.log(`Sau đó, gọi API UC34 tại endpoint: /api/v1/specifications/${project._id}/generate-priority`)

    process.exit(0)
  } catch (error) {
    console.error("🔴 Lỗi seed data:", error)
    process.exit(1)
  }
}

seedTestData()
