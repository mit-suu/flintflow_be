/**
 * Dọn reservation credit treo quá `expires_at` (task-04), mỗi phút. Driver inline: `setInterval` trong API như trước;
 * driver bullmq: job scheduler — chạy nhiều instance API vẫn chỉ dọn một lần mỗi chu kỳ.
 */

import { defineJob } from "../queue/job-runner.js"
import { expireStaleReservations } from "./credit-reservation.service.js"

export const expireReservationsJob = defineJob<unknown>({
  queue: "system",
  name: "expire-reservations",
  repeatEveryMs: 60_000,
  options: { removeOnComplete: true, removeOnFail: { age: 24 * 3600 } },
  process: async () => {
    const { expiredCount, releasedCredits } = await expireStaleReservations()
    if (expiredCount > 0) console.log(`[CreditReservation] Expired ${expiredCount} reservation(s), released ${releasedCredits} credit(s)`)
  },
  onFinalFailure: async (_data, error) => console.error("[CreditReservation] expireStaleReservations failed:", error)
})
