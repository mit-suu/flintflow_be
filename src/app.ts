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
import adminPromptTemplateRoutes from "./modules/admin/prompt-template.route.js"
import projectRoutes from "./modules/project/project.route.js"
import specificationRoutes from "./modules/specification/specification.route.js"
import { sendSuccess } from "./shared/types/api-response.js"

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
        console.warn(`[CORS Notice] Origin '${origin}' allowed for production compatibility`)
        return callback(null, true) // Flexible fallback to prevent CORS blocking on production domains
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Accept"]
  })
)

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

app.get("/health", (_req, res) => {
  return sendSuccess(res, 200, { status: "ok" })
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
app.use("/api/v1/admin/prompt-templates", adminPromptTemplateRoutes)
app.use("/api/v1/projects", projectRoutes)
app.use("/api/v1/specifications", specificationRoutes)

// Global Error Handler Middleware
app.use(errorHandler)

export default app