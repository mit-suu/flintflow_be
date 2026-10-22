import { describe, it, expect } from "vitest"
import { findJobDef } from "../../shared/queue/job-runner.js"
import { planConfig } from "./plan.config.js"
import { nextPeriodStart } from "./subscription-renewal.service.js"
import "./subscription-renewal.jobs.js"

const DAY = 86_400_000

describe("nextPeriodStart", () => {
  it("kỳ mới nối tiếp cuối kỳ cũ khi job chạy trễ ít hơn một kỳ", () => {
    const end = new Date("2026-10-01T00:00:00.000Z")
    const now = new Date(end.getTime() + 3 * DAY)
    expect(nextPeriodStart(end, now)).toBe(end)
  })

  it("job dừng quá một kỳ ⇒ bắt đầu lại từ now", () => {
    const end = new Date("2026-10-01T00:00:00.000Z")
    const now = new Date(end.getTime() + (planConfig.periodDays + 1) * DAY)
    expect(nextPeriodStart(end, now)).toBe(now)
  })
})

describe("renew-subscriptions job", () => {
  it("đăng ký job định kỳ mỗi giờ ở queue system", () => {
    const def = findJobDef("system", "renew-subscriptions")
    expect(def?.repeatEveryMs).toBe(60 * 60_000)
  })
})
