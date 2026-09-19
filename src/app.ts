import express from "express"
import cors from "cors"
import cookieParser from "cookie-parser"
import morgan from "morgan"
import swaggerUi from "swagger-ui-express"
import { env } from "./config/env.js"
import { connectDB } from "./config/database.js"
import { specs } from "./config/swagger.js"
import { errorHandler } from "./shared/middlewares/error-handler.js"
import authRoutes from "./modules/auth/auth.route.js"
import userRoutes from "./modules/user/user.route.js"
import aiActionRoutes from "./shared/ai/ai-action.route.js"
import adminRoutes from "./modules/admin/admin.route.js"
import projectRoutes from "./modules/project/project.route.js"
import notificationRoutes from "./modules/notification/notification.route.js"
import billingRoutes from "./modules/billing/billing.route.js"
import spineRoutes from "./modules/spine/spine.route.js"
import changesRoutes from "./modules/spine/changes.route.js"
import flagsRoutes from "./modules/spine/flags.route.js"
import diagramRoutes from "./modules/diagram/diagram.route.js"
import pipelineRoutes from "./modules/pipeline/pipeline.route.js"
import baselineRoutes from "./modules/pipeline/s9/baseline.route.js"
import renderRoutes from "./modules/render/render.route.js"
import exportRoutes from "./modules/render/export.route.js"
import feedbackRoutes from "./modules/feedback/feedback.route.js"
import { sendSuccess } from "./shared/types/api-response.js"
import { buildHealthReport } from "./config/health.js"

const app = express()

// Connect to database
connectDB()

// CORS Configuration with multi-origin and domain normalization
const configuredOrigins = env.CLIENT_URL
  ? env.CLIENT_URL.split(",").map((url) => url.trim())
  : []

const defaultAllowedOrigins = [
  "https://www.flintflow.io.vn",
  "https://flintflow.io.vn",
  "http://localhost:3000",
  "http://localhost:5000"
]

const allowedOrigins = Array.from(new Set([...defaultAllowedOrigins, ...configuredOrigins]))

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like Server-to-Server, Curl, Postman)
      if (!origin) {
        return callback(null, true)
      }

      const cleanOrigin = origin.replace(/\/$/, "").toLowerCase()
      
      const isAllowed = allowedOrigins.some((allowed) => {
        const cleanAllowed = allowed.replace(/\/$/, "").toLowerCase()
        return (
          cleanOrigin === cleanAllowed ||
          cleanOrigin === `https://${cleanAllowed}` ||
          cleanOrigin === `http://${cleanAllowed}` ||
          cleanOrigin.endsWith(".flintflow.io.vn") ||
          cleanOrigin.endsWith("flintflow.io.vn")
        )
      })

      if (isAllowed) {
        return callback(null, true)
      } else {
        if (env.NODE_ENV !== "production") {
          // Dev / staging: cảnh báo nhưng vẫn cho qua để không cản trở Postman, curl, etc.
          console.warn(`[CORS] Non-production: allowing unlisted origin '${origin}'`)
          return callback(null, true)
        }
        // Production: reject nghiêm ngặt — không cho phép origin không có trong whitelist
        return callback(new Error(`CORS: Origin '${origin}' is not allowed`))
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Accept"],
    // Trình duyệt chỉ cho JS đọc header ngoài danh sách safelist khi có Access-Control-Expose-Headers:
    // FE tải .docx qua fetch cần đọc tên file BE đặt trong Content-Disposition (GET /export/word).
    exposedHeaders: ["Content-Disposition"]
  })
)

// Preview export nhận RenderedDocument có ảnh base64 — vượt giới hạn 100KB mặc định.
// Parser riêng chạy trước; parser chung bỏ qua body đã parse.
app.use("/api/v1/export", express.json({ limit: "15mb" }))
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(cookieParser())
app.use(morgan("dev"))

// Base routes
app.get("/", (req, res) => {
  const protocol = req.headers["x-forwarded-proto"] || req.protocol || "https"
  const host = req.get("host")
  return sendSuccess(res, 200, {
    message: "FlintFlow API running",
    version: "1.0.0",
    docs: `${protocol}://${host}/api-docs`
  })
})

/**
 * `mongo: "error"` ⇒ 503 để load balancer rút instance ra khỏi vòng phục vụ.
 * `plantuml: "error"` chỉ là `degraded` ⇒ vẫn 200: diagram hỏng nhưng phần còn lại phục vụ được.
 */
app.get("/health", async (_req, res) => {
  const report = await buildHealthReport()
  return sendSuccess(res, report.status === "error" ? 503 : 200, report)
})

// Swagger Documentation
app.use(
  "/api-docs",
  swaggerUi.serve,
  swaggerUi.setup(specs, {
    swaggerOptions: {
      persistAuthorization: true
    }
  })
)

// API Routes
app.use("/api/v1/auth", authRoutes)
app.use("/api/v1/users", userRoutes)
app.use("/api/v1/ai-actions", aiActionRoutes)
app.use("/api/v1/admin", adminRoutes)
app.use("/api/v1/projects", projectRoutes)
app.use("/api/v1/projects", spineRoutes)
app.use("/api/v1/projects", changesRoutes)
app.use("/api/v1/projects", flagsRoutes)
app.use("/api/v1/projects", diagramRoutes)
app.use("/api/v1/projects", pipelineRoutes)
app.use("/api/v1/projects", baselineRoutes)
// GET /:projectId/export/word (endpoint 18, contract) đã có trong renderRoutes (render.route.ts,
// review C1) — không mount exportRoutes ở /api/v1/projects nữa (trùng mount từng lộ thêm
// POST /projects/word/preview và GET /projects/:projectId/export/word/export/word).
app.use("/api/v1/projects", renderRoutes)
app.use("/api/v1/notifications", notificationRoutes)
app.use("/api/v1/billing", billingRoutes)
app.use("/api/v1/feedback", feedbackRoutes)
app.use("/api/v1/export", exportRoutes)

// Global Error Handler Middleware
app.use(errorHandler)

export default app