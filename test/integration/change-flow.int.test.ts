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
    // FLF-294: sau baseline lượt áp là một change request — người yêu cầu + nguồn + lý do
    const changeRequest = { requester: "Ms. Lan", source: { kind: "meeting_minutes", ref: "Minutes 15/10" } }
    const noCr = await api.post("/changes", { base_version: await api.version(), reason: "Customer renamed the role", ops })
    expect(noCr.status).toBe(400)
    expect(noCr.body.error.code).toBe("CR_FIELDS_REQUIRED")

    const noReason = await api.post("/changes", { base_version: await api.version(), ops, change_request: changeRequest })
    expect(noReason.status).toBe(400)
    expect(noReason.body.error.code).toBe("VALIDATION_ERROR")

    const withReason = await api.post("/changes", { base_version: await api.version(), reason: "Customer renamed the role", ops, change_request: changeRequest })
    expect(withReason.status, JSON.stringify(withReason.body.error)).toBe(200)
    expect(withReason.body.meta.branch).toBe("post_baseline")
    expect(withReason.body.meta.cr_id).toBe("CR-001")

    // BR-03: sau baseline không hoàn tác — gỡ thay đổi là một CR mới
    const undo = await api.post("/undo", { base_version: await api.version() })
    expect(undo.status).toBe(409)
    expect(undo.body.error.code).toBe("UNDO_AFTER_BASELINE")
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

describe("FLF-311 — thêm use case kéo theo chức năng, màn, luồng, phân quyền", () => {
  /** Lô model soạn cho "Thêm use case Send Absence Warning cho Business Analyst" (fixture đã qua S-5). */
  const fullBatch = [
    { op: "add", path: "use_cases[]", value: { name: "Send Absence Warning", actor_ids: ["A02"], function_ids: ["$newFn"], description: "The analyst warns students over the absence limit." } },
    { op: "add", path: "screens[]", value: { id: "$newScreen", name: "Absence Warning", description: "Lists students over the absence limit.", feature_id: "F3", flow_to: ["S07"], tabs: [] } },
    {
      op: "add",
      path: "functions[]",
      value: {
        id: "$newFn",
        name: "Send Absence Warning",
        screen_id: "$newScreen",
        feature_id: "F3",
        trigger: "Analyst clicks Send warning.",
        description: "Sends a warning to each student whose absence rate is above 20%.",
        normal: ["Analyst selects the students.", "System sends the warning."],
        abnormal: ["No student selected: system shows an error."],
        validations: [{ kind: "required", statement: "At least one student must be selected." }],
        business_rule_ids: []
      }
    },
    { op: "set", path: "screens[id=S07].flow_to", value: ["S08", "S09", "S10", "$newScreen"] },
    { op: "add", path: "permissions[]", value: { screen_id: "$newScreen", role_id: "R2", action: "view" } },
    { op: "add", path: "messages[]", value: { code: "E-WARN-001", text: "Select at least one student, then send the warning again.", function_ids: ["$newFn"] } }
  ]
  const instruction = "Thêm use case Send Absence Warning cho Business Analyst, làm màn hình riêng"

  const addUseCase = async (api: ReturnType<typeof client>, extra: object = {}) => {
    mockOverrides.next = () => JSON.stringify({ ops: fullBatch, notes: "Thêm chức năng, màn, luồng và phân quyền." })
    const preview = await api.post("/changes/preview", { base_version: await api.version(), instruction })
    expect(preview.status, JSON.stringify(preview.body.error)).toBe(200)
    const planned = changesPreviewResponseSchema.parse(preview.body.data)
    expect(planned.ok, JSON.stringify(planned.violations)).toBe(true)
    return api.post("/changes", { base_version: await api.version(), instruction, preview_id: planned.preview_id, ...extra })
  }

  it("một bản xem trước, áp một lần ⇒ UC + chức năng đủ chi tiết + màn trong screen flow + phân quyền, bất biến giữ", async () => {
    const seeded = await seedFixture("full")
    const api = client(seeded)

    const applied = await addUseCase(api)
    expect(applied.status, JSON.stringify(applied.body.error)).toBe(200)
    const spine = applyResultResponseSchema.parse(applied.body.data).spine
    const uc = spine.use_cases.find((u) => u.name === "Send Absence Warning")!
    const fn = spine.functions.find((f) => f.id === uc.function_ids[0])!
    const screen = spine.screens.find((s) => s.id === fn.screen_id)!
    expect(fn.abnormal).toHaveLength(1)
    expect(fn.validations[0].id).toBe(`${fn.id}-V1`)
    expect(screen).toMatchObject({ detail_status: "signed_off", primary_function_id: fn.id, feature_id: "F3" })
    expect(spine.screens.find((s) => s.id === "S07")?.flow_to).toContain(screen.id)
    expect(spine.permissions.some((p) => p.screen_id === screen.id && p.role_id === "R2")).toBe(true)
    expect(spine.messages.find((m) => m.code === "E-WARN-001")?.function_ids).toEqual([fn.id])
  })

  it("sau baseline ⇒ cả lô là MỘT change request (một mã CR cho mọi dòng thay đổi)", async () => {
    const seeded = await seedFixture("full")
    const api = client(seeded)
    expect((await api.post("/baseline", { base_version: seeded.spineVersion })).status).toBe(201)

    const applied = await addUseCase(api, {
      reason: "Phòng đào tạo cần cảnh báo vắng",
      change_request: { requester: "Ms. Lan", source: { kind: "meeting_minutes", ref: "Minutes 15/10" } }
    })
    expect(applied.status, JSON.stringify(applied.body.error)).toBe(200)
    expect(applied.body.meta.cr_id).toBe("CR-001")
    const reasons = new Set(applyResultResponseSchema.parse(applied.body.data).changes.map((c) => c.reason))
    expect([...reasons]).toEqual(["CR-001 · Ms. Lan · meeting minutes: Minutes 15/10 — Phòng đào tạo cần cảnh báo vắng"])
  })
})
