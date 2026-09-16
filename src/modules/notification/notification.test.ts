import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest"
import express from "express"
import mongoose from "mongoose"
import type { Server } from "http"
import type { AddressInfo } from "net"

vi.mock("./notification.model.js", async () => {
  const { fakeDb } = await import("../billing/__tests__/fake-mongo.js")
  return { Notification: fakeDb.model("Notification") }
})
vi.mock("../user/user.model.js", async () => {
  const { fakeDb } = await import("../billing/__tests__/fake-mongo.js")
  return { User: fakeDb.model("User") }
})

import { fakeDb } from "../billing/__tests__/fake-mongo.js"
import { errorHandler } from "../../shared/middlewares/error-handler.js"
import { signAccessToken } from "../../shared/auth/jwt.util.js"
import notificationRoutes from "./notification.route.js"
import {
  notify,
  notifyAdmins,
  countUnread,
  listNotifications,
  markRead,
  markAllRead
} from "./notification.service.js"

const USER = "64b000000000000000000010"
const OTHER_USER = "64b000000000000000000011"

const notifications = () => fakeDb.model("Notification")

const payload = (title = "Thanh toán thành công") => ({
  type: "payment_success",
  title,
  body: "Đã cộng 100 credit",
  link: "/home/billing"
})

describe("notification.service", () => {
  beforeEach(() => {
    fakeDb.reset()
    vi.restoreAllMocks()
  })

  it("notify tạo bản ghi chưa đọc", async () => {
    const created = await notify(USER, payload())

    expect(created).toMatchObject({ type: "payment_success", link: "/home/billing" })
    expect(created!.readAt ?? null).toBeNull()
    expect(await countUnread(USER)).toBe(1)
  })

  it("notify nuốt lỗi ghi (side effect không làm hỏng luồng chính)", async () => {
    vi.spyOn(notifications(), "create").mockRejectedValueOnce(new Error("db down"))
    vi.spyOn(console, "error").mockImplementation(() => {})

    await expect(notify(USER, payload())).resolves.toBeNull()
  })

  it("notifyAdmins gửi cho mọi admin, không gửi cho user thường", async () => {
    const users = fakeDb.model("User")
    const admin1 = await users.create({ role: "admin" })
    const admin2 = await users.create({ role: "admin" })
    await users.create({ role: "user" })

    const count = await notifyAdmins({ type: "admin_new_user", title: "Người dùng mới", body: "x" })

    expect(count).toBe(2)
    expect(await countUnread(String(admin1._id))).toBe(1)
    expect(await countUnread(String(admin2._id))).toBe(1)
  })

  it("list lọc unread và trả meta.unreadCount", async () => {
    await notify(USER, payload("a"))
    const b = await notify(USER, payload("b"))
    await notify(OTHER_USER, payload("c"))
    await markRead(USER, String(b!._id))

    const all = await listNotifications(USER)
    const unread = await listNotifications(USER, { unreadOnly: true })

    expect(all.items).toHaveLength(2)
    expect(all.items[0].title).toBe("b")
    expect(unread.items.map((n) => n.title)).toEqual(["a"])
    expect(all.meta.unreadCount).toBe(1)
  })

  it("markRead: giữ readAt đầu tiên, 404 với thông báo của người khác, 400 với id sai", async () => {
    const created = await notify(USER, payload())
    const id = String(created!._id)

    const first = await markRead(USER, id)
    const firstReadAt = first.readAt
    const second = await markRead(USER, id)

    expect(firstReadAt).toBeInstanceOf(Date)
    expect(second.readAt).toBe(firstReadAt)
    await expect(markRead(OTHER_USER, id)).rejects.toMatchObject({ statusCode: 404 })
    await expect(markRead(USER, "abc")).rejects.toMatchObject({ statusCode: 400 })
  })

  it("markAllRead chỉ đánh dấu của user đó", async () => {
    await notify(USER, payload())
    await notify(USER, payload())
    await notify(OTHER_USER, payload())

    expect(await markAllRead(USER)).toBe(2)
    expect(await countUnread(USER)).toBe(0)
    expect(await countUnread(OTHER_USER)).toBe(1)
  })
})

describe("notification routes (HTTP)", () => {
  let server: Server
  let baseUrl: string
  const auth = { Authorization: `Bearer ${signAccessToken({ userId: USER, email: "u@example.com" })}` }

  beforeAll(async () => {
    const app = express()
    app.use(express.json())
    app.use("/api/v1/notifications", notificationRoutes)
    app.use(errorHandler)
    server = app.listen(0)
    await new Promise<void>((resolve) => server.once("listening", () => resolve()))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/notifications`
  })

  afterAll(() => {
    server.close()
  })

  beforeEach(() => {
    fakeDb.reset()
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  it("không token thì 401", async () => {
    const res = await fetch(`${baseUrl}/unread-count`)
    expect(res.status).toBe(401)
  })

  it("unread-count → đánh dấu đã đọc → unread-count giảm; read-all về 0", async () => {
    const first = await notify(USER, payload())
    await notify(USER, payload())

    const count = async () => (await (await fetch(`${baseUrl}/unread-count`, { headers: auth })).json()).data.count

    expect(await count()).toBe(2)

    const readOne = await fetch(`${baseUrl}/${String(first!._id)}/read`, { method: "PATCH", headers: auth })
    expect(readOne.status).toBe(200)
    expect(await count()).toBe(1)

    const unreadList = await (await fetch(`${baseUrl}?unread=1`, { headers: auth })).json()
    expect(unreadList.data).toHaveLength(1)
    expect(unreadList.meta.unreadCount).toBe(1)

    const readAll = await fetch(`${baseUrl}/read-all`, { method: "PATCH", headers: auth })
    expect((await readAll.json()).data).toEqual({ updated: 1 })
    expect(await count()).toBe(0)
  })

  it("PATCH /:id/read với id không tồn tại trả 404", async () => {
    const res = await fetch(`${baseUrl}/${new mongoose.Types.ObjectId()}/read`, {
      method: "PATCH",
      headers: auth
    })
    expect(res.status).toBe(404)
  })
})
