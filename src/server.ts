import dotenv from "dotenv"

dotenv.config()

// Validate asset TRƯỚC khi dựng app: prompt asset thiếu hoặc frontmatter sai
// phải là lỗi khởi động, không phải lỗi phát sinh giữa pipeline.
// Dùng dynamic import cho app.js vì `import` tĩnh bị hoist lên trước mọi câu lệnh.
const { validateStartupAssets, warnStartupConfig } = await import("./config/startup-checks.js")
validateStartupAssets()

const { default: app } = await import("./app.js")

const PORT = process.env.PORT || 5000

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
  // Cảnh báo cấu hình chạy SAU khi đã nghe cổng: probe PlantUML đi qua mạng, không được làm chậm
  // khởi động (container orchestrator tính thời gian tới lúc cổng mở).
  void warnStartupConfig()
})

// Job nền (docs/background-jobs.md). inline: chạy trong tiến trình này, job định kỳ bằng setInterval.
// bullmq: worker riêng (`npm run worker`) — hoặc ngay đây khi WORKERS_IN_PROCESS=true (dev một terminal).
const { env } = await import("./config/env.js")
const { loadJobDefinitions } = await import("./jobs.js")
await loadJobDefinitions()
if (env.JOB_DRIVER === "inline") {
  const { startInlineSchedules } = await import("./shared/queue/job-runner.js")
  startInlineSchedules()
} else if (env.WORKERS_IN_PROCESS) {
  const { installGracefulShutdown, startWorkers } = await import("./shared/queue/workers.js")
  installGracefulShutdown()
  await startWorkers()
}
