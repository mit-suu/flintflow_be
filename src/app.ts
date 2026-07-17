import dotenv from "dotenv"
import express from "express"
import cors from "cors"
import cookieParser from "cookie-parser"
import morgan from "morgan"
import swaggerUi from "swagger-ui-express"
import { connectDB } from "./config/database.js"
import { specs } from "./config/swagger.js"
import { errorMiddleware } from "./middlewares/error.middleware.js"
import authRoutes from "./routes/auth.routes.js"
import userRoutes from "./routes/user.routes.js"

dotenv.config()

const app = express()

// Connect to database
connectDB()

// Middleware
app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    credentials: true
  })
)
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(cookieParser())
app.use(morgan("dev"))

// Routes
app.get("/", (req, res) => {
  res.json({
    message: "FlintFlow API running",
    version: "1.0.0",
    docs: "http://localhost:5000/api-docs"
  })
})

app.get("/health", (req, res) => {
  res.json({
    status: "ok"
  })
})

// Swagger Documentation
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(specs, {
  swaggerOptions: {
    persistAuthorization: true
  }
}))

// API Routes
app.use("/api/v1/auth", authRoutes)
app.use("/api/v1/users", userRoutes)

// Error handling middleware (must be last)
app.use(errorMiddleware)

export default app