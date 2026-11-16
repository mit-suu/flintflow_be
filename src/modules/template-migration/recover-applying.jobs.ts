/** Job định kỳ: phục hồi lần đổi mẫu kẹt ở `applying` (xem `recover-applying.ts`). Driver bullmq: một instance quét mỗi chu kỳ. */
import { defineJob } from "../../shared/queue/job-runner.js"
import { recoverStuckMigrations } from "./recover-applying.js"

export const recoverTemplateMigrationsJob = defineJob<unknown>({
  queue: "system",
  name: "recover-template-migrations",
  repeatEveryMs: 5 * 60_000,
  options: { removeOnComplete: true, removeOnFail: { age: 24 * 3600 } },
  process: async () => {
    const r = await recoverStuckMigrations()
    if (r.applied + r.ready + r.failed > 0) console.log(`[TemplateMigration] phục hồi: ${r.applied} chạy tiếp xong, ${r.ready} về ready, ${r.failed} lỗi`)
  },
  onFinalFailure: async (_data, error) => console.error("[TemplateMigration] recoverStuckMigrations failed:", error)
})
