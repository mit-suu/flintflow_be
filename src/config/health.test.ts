/**
 * `GET /health` phải phân biệt được "chết" với "chạy thiếu một phần" (T24).
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const { mockPing, mockReachable } = vi.hoisted(() => ({
  mockPing: vi.fn(),
  mockReachable: vi.fn()
}))

vi.mock("mongoose", () => ({
  default: {
    connection: {
      get readyState() {
        return state.readyState
      },
      get db() {
        return state.readyState === 1 ? { admin: () => ({ ping: mockPing }) } : undefined
      }
    }
  }
}))
vi.mock("../shared/diagram/plantuml.client.js", () => ({ isPlantUmlReachable: mockReachable }))

const state = { readyState: 1 }

import { buildHealthReport, resetHealthCache } from "./health.js"

beforeEach(() => {
  state.readyState = 1
  mockPing.mockReset().mockResolvedValue({ ok: 1 })
  mockReachable.mockReset().mockResolvedValue(true)
  resetHealthCache()
})

describe("buildHealthReport", () => {
  it("mọi thứ sống ⇒ ok, kèm số asset đã nạp", async () => {
    const report = await buildHealthReport()
    expect(report).toMatchObject({ status: "ok", mongo: "ok", plantuml: "ok" })
    // Asset nạp thật từ đĩa — thiếu là lỗi khởi động, tới được đây thì phải khác 0
    expect(report.assets.skills).toBeGreaterThan(0)
    expect(report.assets.steps).toBeGreaterThan(0)
    expect(report.version).toBeTruthy()
  })

  it("PlantUML chết ⇒ degraded, KHÔNG phải error — diagram hỏng nhưng app còn phục vụ được", async () => {
    mockReachable.mockResolvedValue(false)
    const report = await buildHealthReport()
    expect(report).toMatchObject({ status: "degraded", mongo: "ok", plantuml: "error" })
  })

  it("Mongo chưa kết nối ⇒ error và không thèm ping", async () => {
    state.readyState = 0
    const report = await buildHealthReport()
    expect(report).toMatchObject({ status: "error", mongo: "error" })
    expect(mockPing).not.toHaveBeenCalled()
  })

  it("Mongo có socket nhưng ping hỏng ⇒ vẫn error (readyState một mình không đủ)", async () => {
    mockPing.mockRejectedValue(new Error("not primary"))
    const report = await buildHealthReport()
    expect(report).toMatchObject({ status: "error", mongo: "error" })
  })

  it("kết quả probe PlantUML được cache — health check gọi 10s/lần không đấm liên tục sang đó", async () => {
    await buildHealthReport()
    await buildHealthReport()
    await buildHealthReport()
    expect(mockReachable).toHaveBeenCalledTimes(1)
    // Mongo thì ping mỗi lượt: nó là điều kiện sống/chết, không được trả lời bằng số liệu cũ
    expect(mockPing).toHaveBeenCalledTimes(3)

    resetHealthCache()
    await buildHealthReport()
    expect(mockReachable).toHaveBeenCalledTimes(2)
  })
})
