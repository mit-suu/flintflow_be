/**
 * UC-16 — số dự án tối đa theo gói của tổ chức (`plan.config`: free 3, pro 50). Dự án đã xoá (archived) không
 * tính; tổ chức có gói Pro active thì vượt được trần của Free.
 */
import { describe, it, expect } from "vitest"
import request from "supertest"
import app from "../../src/app.js"
import { Subscription } from "../../src/modules/credits/subscription.model.js"
import { planConfig } from "../../src/modules/billing/plan.config.js"
import { seedFixture, type SeededFixture } from "../setup.js"

const as = (seeded: SeededFixture) => ({ Authorization: `Bearer ${seeded.token}` })
const create = (seeded: SeededFixture, name: string) => request(app).post("/api/v1/projects").set(as(seeded)).send({ name })

/** Seed đã có 1 dự án ⇒ tạo thêm cho đủ `total`. */
const fillTo = async (seeded: SeededFixture, total: number) => {
  for (let i = 2; i <= total; i += 1) expect((await create(seeded, `P${i}`)).status).toBe(201)
}

describe("UC-16 — giới hạn số dự án theo gói", () => {
  it("gói Free đủ trần ⇒ 402 PLAN_LIMIT_PROJECTS", async () => {
    const seeded = await seedFixture("minimal")
    await fillTo(seeded, planConfig.free.maxProjects)

    const res = await create(seeded, "Vượt trần")
    expect(res.status).toBe(402)
    expect(res.body.error.code).toBe("PLAN_LIMIT_PROJECTS")
  })

  it("dự án đã xoá không tính vào trần", async () => {
    const seeded = await seedFixture("minimal")
    await fillTo(seeded, planConfig.free.maxProjects)

    expect((await request(app).delete(`/api/v1/projects/${seeded.projectId}`).set(as(seeded))).status).toBe(200)
    expect((await create(seeded, "Thay chỗ dự án đã xoá")).status).toBe(201)
  })

  it("gói Pro active ⇒ vượt trần Free", async () => {
    const seeded = await seedFixture("minimal")
    const now = new Date()
    await Subscription.findOneAndUpdate(
      { organizationId: seeded.orgId },
      {
        plan: "pro",
        status: "active",
        monthlyCreditsAllotment: planConfig.pro.monthlyCredits,
        currentPeriodStart: now,
        currentPeriodEnd: new Date(now.getTime() + 30 * 86_400_000)
      },
      { upsert: true }
    )
    await fillTo(seeded, planConfig.free.maxProjects)

    expect((await create(seeded, "Dự án thứ tư")).status).toBe(201)
  })
})
