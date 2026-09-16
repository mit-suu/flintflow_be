/**
 * notification (T22) — `/api/v1/notifications/*` qua HTTP trên Mongo thật: sự kiện thật sinh notification
 * (tạo ví lần đầu), lọc/phân trang, đánh dấu đã đọc, cô lập giữa user.
 */
import { describe, it, expect } from "vitest"
import request from "supertest"
import app from "../../src/app.js"
import { authAs, seedFixture, type SeededFixture } from "../setup.js"
import { Notification } from "../../src/modules/notification/notification.model.js"
import { User } from "../../src/modules/user/user.model.js"

const as = (seeded: SeededFixture) => ({ Authorization: `Bearer ${seeded.token}` })

const seedNotifications = async (userId: string, count: number) => {
  for (let i = 0; i < count; i++) {
    await Notification.create({ userId, type: "baseline_created", title: `N${i}`, body: "body", createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)) })
  }
}

describe("sự kiện sinh notification", () => {
  it("ví tạo lần đầu ⇒ user nhận welcome, mọi admin nhận admin_new_user", async () => {
    const admin = await User.create({ email: "admin@flintflow.test", password: "admin-password-123", name: "Admin", role: "admin", emailVerified: true })
    const seeded = await seedFixture("minimal", { balance: null })

    expect((await request(app).get("/api/v1/billing/balance").set(as(seeded))).status).toBe(200)

    // notify là fire-and-forget (không chặn request)
    await expect
      .poll(async () => (await request(app).get("/api/v1/notifications/unread-count").set(as(seeded))).body.data.count)
      .toBe(1)
    const list = await request(app).get("/api/v1/notifications").set(as(seeded))
    expect(list.body.data[0].type).toBe("welcome")

    const adminToken = await authAs({ _id: admin._id, email: admin.email, role: "admin" })
    await expect
      .poll(async () => {
        const res = await request(app).get("/api/v1/notifications").set("Authorization", `Bearer ${adminToken}`)
        return (res.body.data as Array<{ type: string }>).map((n) => n.type)
      })
      .toContain("admin_new_user")
  })
})

describe("đọc và đánh dấu", () => {
  it("phân trang mới nhất trước; unreadOnly; meta.unreadCount", async () => {
    const seeded = await seedFixture("minimal")
    await seedNotifications(seeded.userId, 5)

    const page1 = await request(app).get("/api/v1/notifications?page=1&limit=2").set(as(seeded))
    expect(page1.status).toBe(200)
    expect(page1.body.data.map((n: { title: string }) => n.title)).toEqual(["N4", "N3"])
    expect(page1.body.meta).toMatchObject({ page: 1, limit: 2, total: 5, totalPages: 3, unreadCount: 5 })
  })

  it("PATCH /:id/read giữ readAt đầu tiên; read-all đánh dấu phần còn lại; unread-count về 0", async () => {
    const seeded = await seedFixture("minimal")
    await seedNotifications(seeded.userId, 3)
    const [first] = (await request(app).get("/api/v1/notifications").set(as(seeded))).body.data as Array<{ _id: string }>

    const read = await request(app).patch(`/api/v1/notifications/${first._id}/read`).set(as(seeded))
    expect(read.status).toBe(200)
    const readAt = read.body.data.readAt as string
    expect(readAt).toBeTruthy()
    const reread = await request(app).patch(`/api/v1/notifications/${first._id}/read`).set(as(seeded))
    expect(reread.body.data.readAt).toBe(readAt)

    const all = await request(app).patch("/api/v1/notifications/read-all").set(as(seeded))
    expect(all.body.data.updated).toBe(2)
    expect((await request(app).get("/api/v1/notifications/unread-count").set(as(seeded))).body.data.count).toBe(0)
  })

  it("không đọc/đánh dấu được notification của user khác; id sai định dạng ⇒ 400", async () => {
    const owner = await seedFixture("minimal")
    const other = await seedFixture("minimal")
    await seedNotifications(owner.userId, 1)
    const [note] = (await request(app).get("/api/v1/notifications").set(as(owner))).body.data as Array<{ _id: string }>

    expect((await request(app).get("/api/v1/notifications").set(as(other))).body.data).toEqual([])
    const foreign = await request(app).patch(`/api/v1/notifications/${note._id}/read`).set(as(other))
    expect(foreign.status).toBe(404)
    expect(foreign.body.error.code).toBe("NOTIFICATION_NOT_FOUND")

    const invalid = await request(app).patch("/api/v1/notifications/not-an-id/read").set(as(owner))
    expect(invalid.status).toBe(400)
    expect(invalid.body.error.code).toBe("INVALID_NOTIFICATION_ID")
  })
})
