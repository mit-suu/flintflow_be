/**
 * change-flow (T22) — endpoint 7–11, 15 qua HTTP trên Mongo thật (T17): sửa bằng instruction (provider giả),
 * câu hỏi làm rõ, 3 nhánh silent/dependent/post_baseline, lý do bắt buộc sau baseline, hoà giải, truy vết.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import request from "supertest"

vi.mock("../../src/shared/ai/providers/llm.router.js", async () =>
  (await import("../helpers/mock-llm.js")).mockLlmRouterModule()
)

import app from "../../src/app.js"
import { seedFixture, type SeededFixture } from "../setup.js"
import { mockCalls, mockOverrides, resetMockLlm } from "../helpers/mock-llm.js"
import {
  applyResultResponseSchema,
  changesPreviewResponseSchema,
  traceabilityResponseSchema
} from "../../src/modules/pipeline/pipeline.dto.js"
import { CreditWallet } from "../../src/modules/credits/credit-wallet.model.js"

const client = (seeded: SeededFixture) => {
  const auth = { Authorization: `Bearer ${seeded.token}` }
  const base = `/api/v1/projects/${seeded.projectId}`
  return {
    get: (suffix: string) => request(app).get(`${base}${suffix}`).set(auth),
    post: (suffix: string, body: object = {}) => request(app).post(`${base}${suffix}`).set(auth).send(body),
    version: async () => (await request(app).get(`${base}/spine`).set(auth)).body.data.spine_version as number
  }
}

const renameA01 = { op: "set", path: "actors[id=A01].name", value: "Product Owner", reason: "user rename" }

beforeEach(() => {
  resetMockLlm()
})

describe("sửa bằng instruction", () => {
  it("preview gọi model một lần, trả ops + preview_id; apply với preview_id không gọi lại model và ghi đúng op", async () => {
    const seeded = await seedFixture("full")
    const api = client(seeded)
    mockOverrides.next = () => JSON.stringify({ ops: [renameA01] })
    const instruction = "Rename actor A01 to Product Owner"

    const preview = await api.post("/changes/preview", { base_version: seeded.spineVersion, instruction })
    expect(preview.status, JSON.stringify(preview.body.error)).toBe(200)
    const planned = changesPreviewResponseSchema.parse(preview.body.data)
    expect(planned.ok).toBe(true)
    expect(planned.ops).toEqual([renameA01])
    expect(planned.preview_id).toBeDefined()
    expect(mockCalls.filter((c) => c.kind === "change")).toHaveLength(1)

    const applied = await api.post("/changes", { base_version: seeded.spineVersion, instruction, preview_id: planned.preview_id })
    expect(applied.status, JSON.stringify(applied.body.error)).toBe(200)
    const result = applyResultResponseSchema.parse(applied.body.data)
    expect(result.spine.actors.find((a) => a.id === "A01")?.name).toBe("Product Owner")
    expect(mockCalls.filter((c) => c.kind === "change")).toHaveLength(1)

    // Lượt gọi model đã trừ credit thật
    const wallet = await CreditWallet.findOne({ userId: seeded.userId }).lean()
    expect(wallet?.balance).toBeLessThan(1000)
    expect(wallet?.reserved).toBe(0)
  })

  it("instruction mơ hồ ⇒ preview ok=false kèm clarification; apply ⇒ 409 NEEDS_CLARIFICATION, Spine không đổi", async () => {
    const seeded = await seedFixture("full")
    const api = client(seeded)
    mockOverrides.next = () => JSON.stringify({ clarification_needed: "Which actor do you mean?" })

    const preview = await api.post("/changes/preview", { base_version: seeded.spineVersion, instruction: "make it better" })
    expect(preview.status).toBe(200)
    const planned = changesPreviewResponseSchema.parse(preview.body.data)
    expect(planned.ok).toBe(false)
    expect(planned.clarification).toBe("Which actor do you mean?")

    const applied = await api.post("/changes", { base_version: seeded.spineVersion, instruction: "make it better" })
    expect(applied.status).toBe(409)
    expect(applied.body.error.code).toBe("NEEDS_CLARIFICATION")
    expect(applied.body.meta).toEqual({ clarification: "Which actor do you mean?" })
    expect(await api.version()).toBe(seeded.spineVersion)
  })

  it("body có cả ops lẫn instruction ⇒ 400 VALIDATION_ERROR", async () => {
    const seeded = await seedFixture("full")
    const res = await client(seeded).post("/changes", { base_version: seeded.spineVersion, ops: [renameA01], instruction: "x" })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe("VALIDATION_ERROR")
  })
})

describe("nhánh và baseline", () => {
  it("đổi field có nơi tham chiếu ⇒ nhánh dependent kèm impact (section, sơ đồ, referrer)", async () => {
    const seeded = await seedFixture("full")
    const preview = await client(seeded).post("/changes/preview", { base_version: seeded.spineVersion, ops: [renameA01] })
    const planned = changesPreviewResponseSchema.parse(preview.body.data)
    expect(planned.branch).toBe("dependent")
    expect(planned.impact?.sections.some((s) => s.relation === "owner")).toBe(true)
    expect(planned.impact?.diagrams).toContain("usecase")
    expect(planned.impact?.referrers.length).toBeGreaterThan(0)
  })

  it("sau baseline: thiếu reason ⇒ 400; có reason ⇒ 200 nhánh post_baseline", async () => {
    const seeded = await seedFixture("full")
    const api = client(seeded)
    const baseline = await api.post("/baseline", { base_version: seeded.spineVersion })
    expect(baseline.status, JSON.stringify(baseline.body.error)).toBe(201)

    const ops = [{ op: "set", path: "actors[id=A02].name", value: "Lead Analyst", reason: "rename" }]
    const noReason = await api.post("/changes", { base_version: await api.version(), ops })
    expect(noReason.status).toBe(400)
    expect(noReason.body.error.code).toBe("VALIDATION_ERROR")

    const withReason = await api.post("/changes", { base_version: await api.version(), reason: "Customer renamed the role", ops })
    expect(withReason.status, JSON.stringify(withReason.body.error)).toBe(200)
    expect(withReason.body.meta.branch).toBe("post_baseline")
  })

  it("không có section stale ⇒ reconcile trả preview silent rỗng, không ghi gì", async () => {
    const seeded = await seedFixture("full")
    const api = client(seeded)
    const res = await api.post("/reconcile", { base_version: seeded.spineVersion })
    expect(res.status).toBe(200)
    const planned = changesPreviewResponseSchema.parse(res.body.data)
    expect(planned.branch).toBe("silent")
    expect(planned.ops).toEqual([])
    expect(await api.version()).toBe(seeded.spineVersion)
    expect(mockCalls).toHaveLength(0)
  })
})

describe("GET /traceability", () => {
  it("actor A01 ⇒ đồ thị nối tới use case và màn hình; entity lạ ⇒ 400 VALIDATION_ERROR", async () => {
    const seeded = await seedFixture("full")
    const api = client(seeded)

    const res = await api.get("/traceability?entity=actor&id=A01")
    expect(res.status).toBe(200)
    const graph = traceabilityResponseSchema.parse(res.body.data)
    const kinds = new Set(graph.nodes.map((n) => n.kind))
    expect(kinds.has("use_case")).toBe(true)
    expect(kinds.has("screen")).toBe(true)

    const bad = await api.get("/traceability?entity=bogus&id=A01")
    expect(bad.status).toBe(400)
    expect(bad.body.error.code).toBe("VALIDATION_ERROR")
  })
})
