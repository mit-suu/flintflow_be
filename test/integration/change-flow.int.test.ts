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
import { Change } from "../../src/modules/spine/change.model.js"

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

  it("sau baseline: dự án sang mode 1 (FLF-318) ⇒ mọi lượt sửa thẳng bị từ chối kèm nội dung điền sẵn cho CR; không hoàn tác", async () => {
    const seeded = await seedFixture("full")
    const api = client(seeded)
    const baseline = await api.post("/baseline", { base_version: seeded.spineVersion })
    expect(baseline.status, JSON.stringify(baseline.body.error)).toBe(201)

    const ops = [{ op: "set", path: "actors[id=A02].name", value: "Lead Analyst", reason: "rename" }]
    const changeRequest = { requester: "Ms. Lan", source: { kind: "meeting_minutes", ref: "Minutes 15/10" } }
    for (const body of [{ reason: "Customer renamed the role" }, { change_request: changeRequest }, { reason: "Customer renamed the role", change_request: changeRequest }]) {
      const res = await api.post("/changes", { base_version: await api.version(), ops, ...body })
      expect(res.status).toBe(409)
      expect(res.body.error.code).toBe("CHANGE_REQUIRES_CR")
      expect(res.body.meta.prefill).toBeTruthy()
    }
    expect((await api.get("/spine")).body.data.actors.find((a: { id: string }) => a.id === "A02").name).not.toBe("Lead Analyst")

    // BR-03: sau baseline không hoàn tác — gỡ thay đổi là một CR mới
    const undo = await api.post("/undo", { base_version: await api.version() })
    expect(undo.status).toBe(409)
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

/** Fixture có `last_seq` lớn hơn seq của change mới trong DB test ⇒ bỏ đi để section stale được tính như dự án thật. */
const freshSteps = (spine: Record<string, unknown>) => {
  for (const step of spine.steps as Array<Record<string, unknown>>) {
    step.first_seq = null
    step.last_seq = null
  }
}

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

  const addUseCaseDirect = async (api: ReturnType<typeof client>, extra: object = {}) => {
    mockOverrides.next = () => JSON.stringify({ ops: fullBatch, notes: "Thêm chức năng, màn, luồng và phân quyền." })
    return api.post("/changes", { base_version: await api.version(), instruction, ...extra })
  }

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
    expect(spine.screens.find((s) => s.id === "S07")?.flow_to.map((e) => e.to)).toContain(screen.id)
    expect(spine.permissions.some((p) => p.screen_id === screen.id && p.role_id === "R2")).toBe(true)
    expect(spine.messages.find((m) => m.code === "E-WARN-001")?.function_ids).toEqual([fn.id])
  })

  it("sau baseline (FLF-318): lệnh thêm use case không áp thẳng — từ chối kèm nội dung điền sẵn cho CR (CR soạn lại đủ phần)", async () => {
    const seeded = await seedFixture("full")
    const api = client(seeded)
    expect((await api.post("/baseline", { base_version: seeded.spineVersion })).status).toBe(201)

    const applied = await addUseCaseDirect(api, {
      reason: "Phòng đào tạo cần cảnh báo vắng",
      change_request: { requester: "Ms. Lan", source: { kind: "meeting_minutes", ref: "Minutes 15/10" } }
    })
    expect(applied.status).toBe(409)
    expect(applied.body.error.code).toBe("CHANGE_REQUIRES_CR")
    expect(applied.body.meta.prefill.description).toContain("Send Absence Warning")
  })

  it("FLF-318: ở S-9 thêm use case qua bản xem trước ⇒ không bắt duyệt lại (không section stale mới), ký baseline được ngay", async () => {
    const seeded = await seedFixture("full", { mutate: freshSteps })
    const api = client(seeded)
    const staleBefore = (await api.get("/progress")).body.data.readiness.stale as number

    const applied = await addUseCase(api)
    expect(applied.status, JSON.stringify(applied.body.error)).toBe(200)
    expect((await api.get("/progress")).body.data.readiness.stale).toBe(staleBefore)
    // Lượt ghi lại accepted_at là sổ sách nội bộ — không thêm dòng vào Record of Changes
    const reaccept = await Change.find({ projectId: seeded.projectId, path: /^steps\[id=.+\]\.accepted_at$/, reason: /^gate: đã duyệt qua bản xem trước/ }).lean()
    expect(reaccept.length).toBeGreaterThan(0)

    const signed = await api.post("/baseline", { base_version: await api.version() })
    expect(signed.status, JSON.stringify(signed.body.error ?? signed.body.meta)).toBe(201)
  })

  it("FLF-318 (luật 3g): xoá use case vừa thêm cùng chức năng, màn, thông báo của nó qua bản xem trước ⇒ không section stale mới, ký baseline được", async () => {
    const seeded = await seedFixture("full", { mutate: freshSteps })
    const api = client(seeded)
    const staleBefore = (await api.get("/progress")).body.data.readiness.stale as number
    expect((await addUseCase(api)).status).toBe(200)

    const spine = (await api.get("/spine")).body.data
    const uc = spine.use_cases.find((u: { name: string }) => u.name === "Send Absence Warning")
    const fn = spine.functions.find((f: { id: string }) => f.id === uc.function_ids[0])
    const msg = spine.messages.find((m: { code: string }) => m.code === "E-WARN-001")
    const removal = [
      { op: "remove", path: `use_cases[id=${uc.id}]` },
      { op: "remove", path: `functions[id=${fn.id}]` },
      { op: "remove", path: `screens[id=${fn.screen_id}]` },
      { op: "remove", path: `messages[id=${msg.id}]` }
    ]
    mockOverrides.next = () => JSON.stringify({ ops: removal, notes: "Xoá use case, chức năng, màn và thông báo của nó." })
    const removeInstruction = "Xoá cả luồng: xoá use case Send Absence Warning"
    const preview = await api.post("/changes/preview", { base_version: await api.version(), instruction: removeInstruction })
    expect(preview.status, JSON.stringify(preview.body.error)).toBe(200)
    const planned = changesPreviewResponseSchema.parse(preview.body.data)
    expect(planned.ok, JSON.stringify(planned.violations)).toBe(true)
    const applied = await api.post("/changes", { base_version: await api.version(), instruction: removeInstruction, preview_id: planned.preview_id })
    expect(applied.status, JSON.stringify(applied.body.error)).toBe(200)

    const after = (await api.get("/spine")).body.data
    expect(after.screens.some((s: { id: string }) => s.id === fn.screen_id)).toBe(false)
    expect(after.permissions.some((p: { screen_id: string }) => p.screen_id === fn.screen_id)).toBe(false)
    expect(after.screens.find((s: { id: string }) => s.id === "S07").flow_to.map((e: { to: string }) => e.to)).not.toContain(fn.screen_id)
    expect((await api.get("/progress")).body.data.readiness.stale).toBe(staleBefore)
    const signed = await api.post("/baseline", { base_version: await api.version() })
    expect(signed.status, JSON.stringify(signed.body.error ?? signed.body.meta)).toBe(201)
  })

  it("FLF-318: lô có sửa văn xuôi của use case có sẵn ⇒ vẫn để section phụ thuộc stale (No auto-propagation)", async () => {
    const seeded = await seedFixture("full", { mutate: freshSteps })
    const api = client(seeded)
    const staleBefore = (await api.get("/progress")).body.data.readiness.stale as number
    const edited = [...fullBatch, { op: "set", path: "use_cases[id=UC01].description", value: "Edited description of an existing use case." }]
    mockOverrides.next = () => JSON.stringify({ ops: edited, notes: "Thêm UC và sửa mô tả UC01." })
    const preview = await api.post("/changes/preview", { base_version: await api.version(), instruction })
    expect(preview.status, JSON.stringify(preview.body.error)).toBe(200)
    const planned = changesPreviewResponseSchema.parse(preview.body.data)
    const applied = await api.post("/changes", { base_version: await api.version(), instruction, preview_id: planned.preview_id })
    expect(applied.status, JSON.stringify(applied.body.error)).toBe(200)
    expect((await api.get("/progress")).body.data.readiness.stale).toBeGreaterThan(staleBefore)
  })

  it("FLF-318 (luật 3h): sửa use case qua bản xem trước ⇒ section sở hữu phần đã sửa không stale; section chỉ đọc vẫn chờ hoà giải", async () => {
    const seeded = await seedFixture("full", { mutate: freshSteps })
    const api = client(seeded)
    const staleBefore = (await api.get("/progress")).body.data.readiness.stale as number
    const editInstruction = "sửa use case UC01: đổi tên thành Manage Projects v2"
    mockOverrides.next = () => JSON.stringify({ ops: [{ op: "set", path: "use_cases[id=UC01].name", value: "Manage Projects v2" }], notes: "Đổi tên UC01." })
    const preview = await api.post("/changes/preview", { base_version: await api.version(), instruction: editInstruction })
    expect(preview.status, JSON.stringify(preview.body.error)).toBe(200)
    const planned = changesPreviewResponseSchema.parse(preview.body.data)
    expect(planned.ok, JSON.stringify(planned.violations)).toBe(true)
    const applied = await api.post("/changes", { base_version: await api.version(), instruction: editInstruction, preview_id: planned.preview_id })
    expect(applied.status, JSON.stringify(applied.body.error)).toBe(200)

    const reaccept = await Change.find({ projectId: seeded.projectId, path: /^steps\[id=.+\]\.accepted_at$/, reason: /^gate: đã duyệt qua bản xem trước/ }).lean()
    expect(reaccept.length).toBeGreaterThan(0)
    const sections = (await api.get("/progress")).body.data.readiness.stale as number
    // Section chỉ đọc use case (sơ đồ, ma trận…) vẫn stale — không tự lan truyền
    expect(sections).toBeGreaterThanOrEqual(staleBefore)
  })
})
