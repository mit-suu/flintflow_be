/**
 * Tiến trình worker (`npm run worker` / service `worker` trong docker-compose): nhận job nền từ Redis — I-4, finalize
 * import, đồng bộ embedding, email, dọn reservation credit. Không mở cổng HTTP. Cùng image, cùng `.env` với API.
 * Xem docs/background-jobs.md.
 */

import dotenv from "dotenv"

dotenv.config()

// Job gọi AI ⇒ cần prompt asset như API; thiếu là lỗi khởi động
const { validateStartupAssets, warnStartupConfig } = await import("./config/startup-checks.js")
validateStartupAssets()

const { env } = await import("./config/env.js")
if (env.JOB_DRIVER !== "bullmq") {
  console.error("[worker] JOB_DRIVER khác `bullmq` — job chạy inline trong API, worker không có việc gì. Thoát.")
  process.exit(1)
}

const { connectDB } = await import("./config/database.js")
await connectDB()

const { loadJobDefinitions } = await import("./jobs.js")
await loadJobDefinitions()

const { installGracefulShutdown, startWorkers } = await import("./shared/queue/workers.js")
installGracefulShutdown()
await startWorkers()
void warnStartupConfig()
