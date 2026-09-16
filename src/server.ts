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

// Dọn reservation credit treo quá expires_at (task-04). Không dùng queue lib.
const { expireStaleReservations } = await import("./shared/ai/credit-reservation.service.js")
setInterval(() => {
  expireStaleReservations()
    .then(({ expiredCount, releasedCredits }) => {
      if (expiredCount > 0) {
        console.log(`[CreditReservation] Expired ${expiredCount} reservation(s), released ${releasedCredits} credit(s)`)
      }
    })
    .catch((error) => console.error("[CreditReservation] expireStaleReservations failed:", error))
}, 60_000)
