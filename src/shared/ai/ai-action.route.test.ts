import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import express from "express"
import type { Server } from "http"
import type { AddressInfo } from "net"

// Chỉ test lớp route (auth), không kéo cả pipeline AI vào
vi.mock("./ai-action.controller.js", () => {
  const ok = (_req: express.Request, res: express.Response) => res.status(200).json({ data: { ok: true } })
  return { estimateCostHandler: ok, executeAiActionHandler: ok, retryAiActionHandler: ok }
})

import aiActionRoutes from "./ai-action.route.js"
import { errorHandler } from "../middlewares/error-handler.js"
import { signAccessToken } from "../auth/jwt.util.js"

describe("ai-action routes", () => {
  let server: Server
  let baseUrl: string

  beforeAll(async () => {
    const app = express()
    app.use(express.json())
    app.use("/api/v1/ai-actions", aiActionRoutes)
    app.use(errorHandler)
    server = app.listen(0)
    await new Promise<void>((resolve) => server.once("listening", () => resolve()))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/ai-actions`
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  afterAll(() => {
    server.close()
  })

  const estimate = (headers: Record<string, string> = {}) =>
    fetch(`${baseUrl}/estimate-cost`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ actionType: "chat" })
    })

  it("POST /estimate-cost không auth trả 401", async () => {
    const res = await estimate()
    expect(res.status).toBe(401)
  })

  it("POST /estimate-cost có token hợp lệ đi tới handler", async () => {
    const token = signAccessToken({ userId: "64b000000000000000000030", email: "u@example.com" })
    const res = await estimate({ Authorization: `Bearer ${token}` })
    expect(res.status).toBe(200)
  })
})
