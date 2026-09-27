/**
 * FLF-221 — `PATCH /projects/:id/assumptions/:assumptionId`: user sửa giả định bằng ngôn ngữ của mình, AI dịch sang
 * tiếng Anh (provider giả) và ghi cả hai trong một transaction; model lỗi thì không ghi gì.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import request from "supertest"

vi.mock("../../src/shared/ai/providers/llm.router.js", async () =>
  (await import("../helpers/mock-llm.js")).mockLlmRouterModule()
)

import app from "../../src/app.js"
import { seedFixture } from "../setup.js"
import { mockCalls, mockOverrides, resetMockLlm } from "../helpers/mock-llm.js"
import { CreditWallet } from "../../src/modules/credits/credit-wallet.model.js"

beforeEach(() => {
  resetMockLlm()
})

describe("PATCH /projects/:id/assumptions/:assumptionId", () => {
  it("ghi statement_vi user gõ và statement EN do AI dịch, trừ credit một lượt", async () => {
    const seeded = await seedFixture("full")
    const auth = { Authorization: `Bearer ${seeded.token}` }
    mockOverrides.next = (prompt) =>
      prompt.includes("User's edited sentence") ? JSON.stringify({ statement: "99.9% monthly availability is required." }) : undefined

    const res = await request(app)
      .patch(`/api/v1/projects/${seeded.projectId}/assumptions/AS01`)
      .set(auth)
      .send({ statement_vi: "Cần sẵn sàng 99,9% mỗi tháng.", base_version: seeded.spineVersion })

    expect(res.status, JSON.stringify(res.body.error)).toBe(200)
    expect(res.body.data.spine_version).toBe(seeded.spineVersion + 1)
    const edited = (res.body.data.spine.assumptions as { id: string; statement: string; statement_vi?: string }[]).find((a) => a.id === "AS01")
    expect(edited).toMatchObject({ statement: "99.9% monthly availability is required.", statement_vi: "Cần sẵn sàng 99,9% mỗi tháng." })
    expect(mockCalls).toHaveLength(1)

    const wallet = await CreditWallet.findOne({ userId: seeded.userId }).lean()
    expect(wallet?.reserved).toBe(0)
    expect(wallet?.balance).toBeLessThan(1000)
  })

  it("model lỗi ⇒ không ghi gì, spine_version giữ nguyên", async () => {
    const seeded = await seedFixture("full")
    const auth = { Authorization: `Bearer ${seeded.token}` }
    mockOverrides.next = () => new Error("provider down")

    const res = await request(app)
      .patch(`/api/v1/projects/${seeded.projectId}/assumptions/AS01`)
      .set(auth)
      .send({ statement_vi: "Cần sẵn sàng 99,9% mỗi tháng.", base_version: seeded.spineVersion })

    expect(res.status).toBeGreaterThanOrEqual(400)
    const spine = (await request(app).get(`/api/v1/projects/${seeded.projectId}/spine`).set(auth)).body.data
    expect(spine.spine_version).toBe(seeded.spineVersion)
    expect(spine.assumptions.find((a: { id: string }) => a.id === "AS01").statement_vi).toBeUndefined()
  })

  it("base_version lệch ⇒ 409, không gọi model; giả định không có ⇒ 404", async () => {
    const seeded = await seedFixture("full")
    const auth = { Authorization: `Bearer ${seeded.token}` }
    const url = `/api/v1/projects/${seeded.projectId}/assumptions`

    const stale = await request(app).patch(`${url}/AS01`).set(auth).send({ statement_vi: "x", base_version: seeded.spineVersion + 5 })
    expect(stale.status).toBe(409)
    expect(stale.body.error.code).toBe("SPINE_VERSION_CONFLICT")

    const missing = await request(app).patch(`${url}/AS99`).set(auth).send({ statement_vi: "x", base_version: seeded.spineVersion })
    expect(missing.status).toBe(404)
    expect(missing.body.error.code).toBe("ASSUMPTION_NOT_FOUND")
    expect(mockCalls).toHaveLength(0)
  })
})
