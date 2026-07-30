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
import { sendSuccess } from "./shared/types/api-response.js"

const app = express()

// Connect to database
connectDB()

// Middleware
app.use(
  cors({
    origin: env.CLIENT_URL,
    credentials: true
  })
)
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(cookieParser())
app.use(morgan("dev"))

// Base routes
app.get("/", (_req, res) => {
  return sendSuccess(res, 200, {
    message: "FlintFlow API running",
    version: "1.0.0",
    docs: `http://localhost:${env.PORT}/api-docs`
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

// Global Error Handler Middleware
app.use(errorHandler)

export default app