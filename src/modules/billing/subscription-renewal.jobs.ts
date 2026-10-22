/**
 * UC-80 (FLF-309): mỗi giờ sang kỳ mới cho gói đã hết hạn — Pro về Free, nạp lại credit theo hạn mức. Driver inline:
 * `setInterval` trong API; driver bullmq: job scheduler, nhiều instance vẫn chỉ quét một lần mỗi chu kỳ.
 */

import { defineJob } from "../../shared/queue/job-runner.js"
import { renewDueSubscriptions } from "./subscription-renewal.service.js"

export const renewSubscriptionsJob = defineJob<unknown>({
  queue: "system",
  name: "renew-subscriptions",
  repeatEveryMs: 60 * 60_000,
  options: { removeOnComplete: true, removeOnFail: { age: 24 * 3600 } },
  process: async () => {
    const { renewed, downgraded, creditsGranted } = await renewDueSubscriptions()
    if (renewed + downgraded > 0) {
      console.log(`[Billing] Sang kỳ mới ${renewed} gói, hạ ${downgraded} gói về Free, cấp ${creditsGranted} credit`)
    }
  },
  onFinalFailure: async (_data, error) => console.error("[Billing] renewDueSubscriptions failed:", error)
})
