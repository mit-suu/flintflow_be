import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest"
import express from "express"
import type { Server } from "http"
import type { AddressInfo } from "net"

vi.mock("./admin.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./admin.service.js")>()
  return {
    ...actual,
    listUsers: vi.fn(async () => ({ items: [], meta: { page: 1, limit: 20, total: 0, totalPages: 1 } })),
    getUserDetail: vi.fn(async (id: string) => ({ _id: id, recentTransactions: [] })),
    getMetrics: vi.fn(async () => ({ usersTotal: 3, baselinesTotal: 0 })),
    getAiCost: vi.fn(async () => ({ rows: [], totals: {} })),
    listFeedback: vi.fn(async () => [])
  }
})
// adminMiddleware luôn tra role/isActive trong DB (không tin role của JWT)
vi.mock("../user/user.model.js", () => ({
  User: {
    findById: vi.fn(async (id: string) => ({
      role: id === "64b000000000000000000001" ? "admin" : "user",
      isActive: true
    }))
  }
}))

import { User } from "../user/user.model.js"
import { errorHandler } from "../../shared/middlewares/error-handler.js"
import { signAccessToken } from "../../shared/auth/jwt.util.js"
import adminRoutes from "./admin.route.js"
import * as adminService from "./admin.service.js"
import { estimateUsd, mergeCostRows, UNATTRIBUTED_KEY } from "./admin.service.js"
import { parseDateInput, resolveDateRange } from "./admin.validation.js"

const ADMIN = "64b000000000000000000001"
const USER = "64b000000000000000000002"

describe("admin routes (HTTP)", () => {
  let server: Server
  let baseUrl: string
  const adminAuth = {
    Authorization: `Bearer ${signAccessToken({ userId: ADMIN, email: "admin@example.com", role: "admin" })}`
  }
  const userAuth = {
    Authorization: `Bearer ${signAccessToken({ userId: USER, email: "user@example.com", role: "user" })}`
  }
  const legacyUserAuth = {
    Authorization: `Bearer ${signAccessToken({ userId: USER, email: "user@example.com" })}`
  }

  const PATHS = ["/users", `/users/${USER}`, "/metrics", "/ai-cost", "/feedback"]

  beforeAll(async () => {
    const app = express()
    app.use(express.json())
    app.use("/api/v1/admin", adminRoutes)
    app.use(errorHandler)
    server = app.listen(0)
    await new Promise<void>((resolve) => server.once("listening", () => resolve()))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/admin`
  })

  afterAll(() => {
    server.close()
  })

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  it("không token thì 401", async () => {
    for (const path of PATHS) {
      expect((await fetch(`${baseUrl}${path}`)).status, path).toBe(401)
    }
  })

  it("token còn role admin nhưng DB đã hạ quyền hoặc khoá tài khoản ⇒ 403", async () => {
    vi.mocked(User.findById).mockResolvedValueOnce({ role: "user", isActive: true } as never)
    expect((await fetch(`${baseUrl}/metrics`, { headers: adminAuth })).status).toBe(403)

    vi.mocked(User.findById).mockResolvedValueOnce({ role: "admin", isActive: false } as never)
    expect((await fetch(`${baseUrl}/metrics`, { headers: adminAuth })).status).toBe(403)
  })

  it("user thường nhận 403 (cả token có role và token cũ tra DB)", async () => {
    for (const path of PATHS) {
      expect((await fetch(`${baseUrl}${path}`, { headers: userAuth })).status, path).toBe(403)
      expect((await fetch(`${baseUrl}${path}`, { headers: legacyUserAuth })).status, path).toBe(403)
    }
    expect(adminService.getMetrics).not.toHaveBeenCalled()
  })

  it("admin nhận 200 với envelope chuẩn", async () => {
    for (const path of PATHS) {
      const res = await fetch(`${baseUrl}${path}`, { headers: adminAuth })
      expect(res.status, path).toBe(200)
      expect((await res.json()).error, path).toBeNull()
    }
    const feedback = await (await fetch(`${baseUrl}/feedback`, { headers: adminAuth })).json()
    expect(feedback.data).toEqual([])
  })

  it("truyền query đã validate xuống service", async () => {
    await fetch(`${baseUrl}/users?page=2&limit=5&role=admin&isActive=false&q=%20an%20`, { headers: adminAuth })
    expect(adminService.listUsers).toHaveBeenLastCalledWith({
      page: 2,
      limit: 5,
      role: "admin",
      isActive: false,
      q: "an"
    })

    await fetch(`${baseUrl}/ai-cost?from=2026-09-01&to=2026-09-14&groupBy=provider`, { headers: adminAuth })
    expect(adminService.getAiCost).toHaveBeenLastCalledWith(
      { from: new Date("2026-08-31T17:00:00.000Z"), to: new Date("2026-09-14T17:00:00.000Z") },
      "provider"
    )
  })

  it("tham số sai trả 400", async () => {
    const bad = [
      "/users?limit=500",
      "/users?isActive=yes",
      "/users/not-an-id",
      "/ai-cost?groupBy=model",
      "/ai-cost?from=hello",
      "/ai-cost?from=2026-09-10&to=2026-09-01"
    ]
    for (const path of bad) {
      expect((await fetch(`${baseUrl}${path}`, { headers: adminAuth })).status, path).toBe(400)
    }
  })
})

describe("admin.validation date range", () => {
  it("ngày YYYY-MM-DD tính theo giờ VN, to là cận trên loại trừ", () => {
    expect(parseDateInput("2026-09-14", "start").toISOString()).toBe("2026-09-13T17:00:00.000Z")
    expect(parseDateInput("2026-09-14", "end").toISOString()).toBe("2026-09-14T17:00:00.000Z")
  })

  it("mặc định 30 ngày gần nhất; quá 366 ngày thì 400", () => {
    const now = new Date("2026-09-14T00:00:00.000Z")
    const range = resolveDateRange({}, now)
    expect(range.to).toEqual(now)
    expect(now.getTime() - range.from.getTime()).toBe(30 * 24 * 60 * 60 * 1000)

    expect(() => resolveDateRange({ from: "2024-01-01", to: "2026-01-01" })).toThrow(/366/)
  })
})

describe("admin.service ai-cost merge", () => {
  it("ước tính USD theo provider; provider lạ tính 0", () => {
    expect(estimateUsd("openai", 1000, 1000)).toBeCloseTo(0.00075)
    expect(estimateUsd("mock", 5000, 5000)).toBe(0)
    expect(estimateUsd("unknown", 5000, 5000)).toBe(0)
  })

  it("gộp token theo key × provider với credit theo key; tổng credit giữ nguyên", () => {
    const { rows, totals } = mergeCostRows(
      "actionType",
      [
        { key: "chat", provider: "openai", calls: 3, failedCalls: 1, promptTokens: 1000, completionTokens: 1000 },
        { key: "chat", provider: "anthropic", calls: 1, failedCalls: 0, promptTokens: 1000, completionTokens: 0 },
        { key: "generate_section", provider: "openai", calls: 2, failedCalls: 0, promptTokens: 0, completionTokens: 0 }
      ],
      [
        { key: "chat", credits: 6 },
        { key: "generate_section", credits: 10 },
        { key: "summarize_document", credits: 2 }
      ]
    )

    expect(rows.map((r) => r.key)).toEqual(["generate_section", "chat", "summarize_document"])
    const chat = rows.find((r) => r.key === "chat")!
    expect(chat).toMatchObject({ calls: 4, failedCalls: 1, promptTokens: 2000, completionTokens: 1000, credits: 6 })
    expect(chat.estimatedUsd).toBeCloseTo(0.00375)
    expect(totals).toMatchObject({ calls: 6, credits: 18 })
  })

  it("groupBy=day sắp theo ngày tăng dần; provider giữ credit ở dòng unattributed", () => {
    const byDay = mergeCostRows("day", [], [
      { key: "2026-09-03", credits: 1 },
      { key: "2026-09-01", credits: 2 }
    ])
    expect(byDay.rows.map((r) => r.key)).toEqual(["2026-09-01", "2026-09-03"])

    const byProvider = mergeCostRows(
      "provider",
      [{ key: "openai", provider: "openai", calls: 1, failedCalls: 0, promptTokens: 10, completionTokens: 10 }],
      [{ key: UNATTRIBUTED_KEY, credits: 5 }],
      new Map([[UNATTRIBUTED_KEY, "Không xác định provider"]])
    )
    expect(byProvider.totals.credits).toBe(5)
    expect(byProvider.rows.find((r) => r.key === UNATTRIBUTED_KEY)?.label).toBe("Không xác định provider")
  })
})
