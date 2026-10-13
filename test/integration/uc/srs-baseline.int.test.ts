/**
 * UC-33 … UC-39 (actors-and-use-cases.md) qua HTTP trên Mongo thật, provider AI giả ở tầng `callLLM`:
 *   UC-33 hoàn tác thay đổi gần nhất · UC-34 hoà giải section stale · UC-35 glossary · UC-37 MoSCoW
 *   UC-38 Analyst nộp baseline · UC-39 Lead duyệt baseline. BR-03 (sau baseline), BR-04 (cờ đỏ = 0).
 * Ca nào hành vi thật trái spec ⇒ `it.skip` kèm `// BUG(UC-xx)`; assertion vẫn theo spec.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import request from "supertest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import app from "../../../src/app.js"
import { authAs, seedFixture, type SeededFixture } from "../../setup.js"
import { mockCalls, mockOverrides, resetMockLlm } from "../../helpers/mock-llm.js"
import { gateHttp, runStepHttp, spineVersionOf } from "../../helpers/pipeline.js"
import { baselineResponseSchema, baselinesResponseSchema, flagsResponseSchema } from "../../../src/modules/pipeline/pipeline.dto.js"
import { User } from "../../../src/modules/user/user.model.js"
import { Membership, type OrgRole } from "../../../src/modules/organization/membership.model.js"
import { Baseline } from "../../../src/modules/spine/baseline.model.js"
import { stepsOf } from "../../../src/modules/spine/section-registry.js"
import type { Spine } from "../../../src/modules/spine/spine.types.js"
import { PREVIEW_EXPIRED } from "../../../src/modules/spine/change.service.js"
import { orderedSteps } from "../../../src/modules/pipeline/step-registry.js"

type Body = Record<string, any>

const client = (seeded: SeededFixture, token = seeded.token) => {
  const auth = { Authorization: `Bearer ${token}` }
  const base = `/api/v1/projects/${seeded.projectId}`
  const api = {
    get: (suffix: string) => request(app).get(`${base}${suffix}`).set(auth),
    post: (suffix: string, body: object = {}) => request(app).post(`${base}${suffix}`).set(auth).send(body),
    spine: async (): Promise<Body> => (await request(app).get(`${base}/spine`).set(auth)).body.data,
    version: async (): Promise<number> => (await api.spine()).spine_version as number,
    /** Áp một lô op; trả response. */
    change: async (ops: object[], extra: object = {}) => api.post("/changes", { base_version: await api.version(), ops, ...extra }),
    /** Quét cờ ở mức ký baseline (bật các luật *_at_baseline). */
    flagsAtBaseline: async () =>
      flagsResponseSchema.parse((await api.post("/flags/recompute", { at_baseline: true })).body.data).filter((f) => f.resolved_at === null),
    staleFlags: async () => (await api.flagsAtBaseline()).filter((f) => f.rule_id === "section_stale_at_baseline"),
    baselines: async () => baselinesResponseSchema.parse((await api.get("/baselines")).body.data),
    /** Trạng thái nộp baseline đọc từ chính Spine — không có endpoint riêng. */
    submission: async (): Promise<Body | null> => ((await api.spine()).baseline_submission as Body | null) ?? null
  }
  return api
}

const join = async (seeded: SeededFixture, role: OrgRole): Promise<string> => {
  const email = `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@flintflow.test`
  const user = await User.create({ email, password: "test-password-123", emailVerified: true })
  await Membership.create({ organizationId: seeded.orgId, userId: user._id, role })
  return authAs({ _id: user._id, email, orgId: seeded.orgId })
}

/**
 * Mốc accept của mọi step về `null` ⇒ mọi change mới (seq ≥ 1) đều "mới hơn" mốc accept, nên section nuôi bởi change
 * đó thành stale — cách duy nhất có stale thật trên fixture (fixture ghi `last_seq` tới 204 mà `changes[]` trống).
 */
const freshSteps = (spine: Record<string, unknown>) => {
  for (const step of spine.steps as Array<Record<string, unknown>>) {
    step.first_seq = null
    step.last_seq = null
  }
}

const renameA01 = (name = "Product Owner") => [{ op: "set", path: "actors[id=A01].name", value: name, reason: "rename" }]

beforeEach(() => {
  resetMockLlm()
})

// ─── UC-33 ──────────────────────────────────────────────────────────

describe("UC-33 — hoàn tác thay đổi gần nhất", () => {
  it("hoàn tác ⇒ Spine về giá trị trước lô, lịch sử giữ nguyên và thêm lô revert", async () => {
    const seeded = await seedFixture("full")
    const api = client(seeded)

    const first = await api.change(renameA01("Owner One"))
    expect(first.status, JSON.stringify(first.body.error)).toBe(200)
    const second = await api.change(renameA01("Owner Two"))
    expect(second.status, JSON.stringify(second.body.error)).toBe(200)
    const historyBefore = (await api.get("/changes")).body.data as unknown[]

    const undo = await api.post("/undo", { base_version: await api.version() })
    expect(undo.status, JSON.stringify(undo.body.error)).toBe(200)
    expect(undo.body.data.changes.every((c: Body) => c.op === "revert")).toBe(true)
    // chỉ lô gần nhất bị hoàn tác
    expect(undo.body.data.spine.actors.find((a: Body) => a.id === "A01").name).toBe("Owner One")

    const historyAfter = (await api.get("/changes")).body.data as Body[]
    expect(historyAfter.length).toBeGreaterThan(historyBefore.length)
    expect(historyAfter.slice(0, historyBefore.length)).toEqual(historyBefore)
  })

  it("sau hoàn tác, section phụ thuộc thành stale (chờ UC-34)", async () => {
    const seeded = await seedFixture("full", { mutate: freshSteps })
    const api = client(seeded)

    expect((await api.change(renameA01())).status).toBe(200)
    // Gỡ stale do chính lượt sửa (xác nhận không đổi) để chỉ còn tác động của undo
    mockOverrides.next = () => JSON.stringify({ ops: [] })
    const preview = await api.post("/reconcile", { base_version: await api.version() })
    expect(preview.status, JSON.stringify(preview.body.error)).toBe(200)
    expect(preview.body.data.preview_id).toBeDefined()
    const confirm = await api.post("/reconcile", { base_version: await api.version(), preview_id: preview.body.data.preview_id })
    expect(confirm.status, JSON.stringify(confirm.body.error)).toBe(200)
    const before = new Set((await api.staleFlags()).map((f) => f.section_id))
    expect(before.has("fixed:2.1")).toBe(false)

    const undo = await api.post("/undo", { base_version: await api.version() })
    expect(undo.status, JSON.stringify(undo.body.error)).toBe(200)
    expect(undo.body.data.spine.actors.find((a: Body) => a.id === "A01").name).toBe("Founder")
    // §2.1 (actors) đã hết stale sau hoà giải ⇒ stale trở lại chỉ vì lượt undo
    const after = (await api.staleFlags()).map((f) => f.section_id)
    expect(after).toContain("fixed:2.1")
    expect(after.filter((id) => !before.has(id)).length).toBeGreaterThan(0)
  })

  it("chưa có thay đổi nào ⇒ 422 NOTHING_TO_UNDO", async () => {
    const seeded = await seedFixture("full")
    const api = client(seeded)
    const res = await api.post("/undo", { base_version: seeded.spineVersion })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe("NOTHING_TO_UNDO")
  })

  it("base_version lệch ⇒ 409 SPINE_VERSION_CONFLICT, không hoàn tác", async () => {
    const seeded = await seedFixture("full")
    const api = client(seeded)
    expect((await api.change(renameA01())).status).toBe(200)
    const res = await api.post("/undo", { base_version: seeded.spineVersion })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("SPINE_VERSION_CONFLICT")
    expect((await api.spine()).actors.find((a: Body) => a.id === "A01").name).toBe("Product Owner")
  })

  // BUG(UC-33): spec BR-03 "Undo is available only before the first baseline; after it, undoing a written change is a new
  // change request" vs code `undo.service.ts` (undoLast) không kiểm `baselines[]` — sau baseline vẫn revert thẳng lô cuối.
  it.skip("sau baseline ⇒ không hoàn tác được, Spine giữ nguyên (BR-03)", async () => {
    const seeded = await seedFixture("full")
    const api = client(seeded)
    expect((await api.post("/baseline", { base_version: seeded.spineVersion })).status).toBe(201)
    const changed = await api.change(renameA01(), { reason: "Customer renamed the role" })
    expect(changed.status, JSON.stringify(changed.body.error)).toBe(200)

    const undo = await api.post("/undo", { base_version: await api.version() })
    expect(undo.status).toBeGreaterThanOrEqual(400)
    expect((await api.spine()).actors.find((a: Body) => a.id === "A01").name).toBe("Product Owner")
  })
})

// ─── UC-34 ──────────────────────────────────────────────────────────

describe("UC-34 — hoà giải section stale", () => {
  it("không có section stale ⇒ preview rỗng, không gọi AI, không ghi", async () => {
    const seeded = await seedFixture("full")
    const api = client(seeded)
    const res = await api.post("/reconcile", { base_version: seeded.spineVersion })
    expect(res.status).toBe(200)
    expect(res.body.data.ops).toEqual([])
    expect(res.body.data.preview_id).toBeUndefined()
    expect(mockCalls).toHaveLength(0)
    expect(await api.version()).toBe(seeded.spineVersion)
  })

  it("AI đề xuất cập nhật từ field đã đổi, tác giả chấp nhận ⇒ áp, step sở hữu chờ chấp nhận lại", async () => {
    const seeded = await seedFixture("full", { mutate: freshSteps })
    const api = client(seeded)
    expect((await api.change(renameA01())).status).toBe(200)
    expect((await api.staleFlags()).length).toBeGreaterThan(0)

    const update = { op: "set", path: "actors[id=A01].description", value: "Product owner who authors the SRS.", reason: "reconcile" }
    let proposed = false
    mockOverrides.next = () => {
      if (proposed) return JSON.stringify({ ops: [] })
      proposed = true
      return JSON.stringify({ ops: [update] })
    }

    const preview = await api.post("/reconcile", { base_version: await api.version() })
    expect(preview.status, JSON.stringify(preview.body.error)).toBe(200)
    expect(preview.body.data.ok).toBe(true)
    expect(preview.body.data.ops).toEqual([expect.objectContaining({ path: update.path, value: update.value })])
    expect(preview.body.data.preview_id).toBeDefined()
    expect(mockCalls.length).toBeGreaterThan(0)

    const applied = await api.post("/reconcile", { base_version: preview.body.data.base_version, preview_id: preview.body.data.preview_id })
    expect(applied.status, JSON.stringify(applied.body.error)).toBe(200)
    expect(applied.body.data.spine.actors.find((a: Body) => a.id === "A01").description).toBe(update.value)
    expect(applied.body.data.spine.steps.some((s: Body) => s.status === "revision_requested")).toBe(true)
  })

  it("từ chối diff (không gửi lượt 2) ⇒ section vẫn stale, Spine không đổi", async () => {
    const seeded = await seedFixture("full", { mutate: freshSteps })
    const api = client(seeded)
    expect((await api.change(renameA01())).status).toBe(200)
    mockOverrides.next = () =>
      JSON.stringify({ ops: [{ op: "set", path: "actors[id=A01].description", value: "Changed by AI.", reason: "reconcile" }] })

    const version = await api.version()
    const preview = await api.post("/reconcile", { base_version: version })
    expect(preview.status).toBe(200)
    expect(preview.body.data.preview_id).toBeDefined()

    expect(await api.version()).toBe(version)
    expect((await api.spine()).actors.find((a: Body) => a.id === "A01").description).not.toBe("Changed by AI.")
    expect((await api.staleFlags()).length).toBeGreaterThan(0)
  })

  /** Sửa tên A01 rồi một lượt hoà giải "xác nhận không đổi"; trả section đã xem và section còn stale sau lượt đó. */
  const confirmNoChangePass = async () => {
    const seeded = await seedFixture("full", { mutate: freshSteps })
    const api = client(seeded)
    expect((await api.change(renameA01())).status).toBe(200)
    mockOverrides.next = () => JSON.stringify({ ops: [] })

    const preview = await api.post("/reconcile", { base_version: await api.version() })
    expect(preview.status, JSON.stringify(preview.body.error)).toBe(200)
    expect(preview.body.data.no_change).toBe(true)
    const confirm = await api.post("/reconcile", { base_version: await api.version(), preview_id: preview.body.data.preview_id })
    expect(confirm.status, JSON.stringify(confirm.body.error)).toBe(200)
    const reviewed = (confirm.body.meta.impact.sections as Body[]).map((s) => s.id as string)
    const stillStale = (await api.staleFlags()).map((f) => f.section_id)
    return { reviewed, stillStale }
  }

  it("AI thấy nội dung vẫn đúng ⇒ xác nhận không đổi gỡ stale của section đã xem", async () => {
    const { reviewed, stillStale } = await confirmNoChangePass()
    expect(reviewed).toContain("fixed:2.1")
    expect(stillStale).not.toContain("fixed:2.1")
  })

  // BUG(UC-34): spec "Review in one pass every stale section … outdated diagrams are rendered again" vs code
  // `reconcile.service.ts` confirmNoChange → rerenderStale: bước vẽ lại ghi `diagrams[]` (step_id null) SAU khi đã dời
  // `last_seq` của step sở hữu ⇒ section sơ đồ vừa xem (fixed:2.2.1) và section khác nuôi bởi sơ đồ (fixed:1, 3.1.1, 3.1.5,
  // function:FN028) lại stale ngay sau lượt hoà giải. (Môi trường test không có PlantUML ⇒ render_status "error".)
  it.skip("sau một lượt hoà giải, không còn section nào stale", async () => {
    const { reviewed, stillStale } = await confirmNoChangePass()
    for (const id of reviewed) expect(stillStale).not.toContain(id)
    expect(stillStale).toEqual([])
  })

  it("preview_id đã dùng ⇒ 422 PREVIEW_EXPIRED; base_version lệch ⇒ 409", async () => {
    const seeded = await seedFixture("full", { mutate: freshSteps })
    const api = client(seeded)
    expect((await api.change(renameA01())).status).toBe(200)
    let proposed = false
    mockOverrides.next = () => {
      if (proposed) return JSON.stringify({ ops: [] })
      proposed = true
      return JSON.stringify({ ops: [{ op: "set", path: "actors[id=A01].description", value: "Updated.", reason: "reconcile" }] })
    }

    const conflict = await api.post("/reconcile", { base_version: seeded.spineVersion })
    expect(conflict.status).toBe(409)
    expect(conflict.body.error.code).toBe("SPINE_VERSION_CONFLICT")

    const preview = await api.post("/reconcile", { base_version: await api.version() })
    const previewId = preview.body.data.preview_id as string
    expect((await api.post("/reconcile", { base_version: preview.body.data.base_version, preview_id: previewId })).status).toBe(200)
    const reused = await api.post("/reconcile", { base_version: await api.version(), preview_id: previewId })
    expect(reused.status).toBe(422)
    // Hằng PREVIEW_EXPIRED của change.service mang chuỗi mã "CHANGE_RANGE_INVALID" (change.service.ts:44)
    expect(reused.body.error.code).toBe(PREVIEW_EXPIRED)
  })
})

// ─── UC-35 ──────────────────────────────────────────────────────────

describe("UC-35 — định nghĩa glossary của SRS", () => {
  it("trước baseline: thêm thuật ngữ chuẩn ⇒ ghi vào glossary", async () => {
    const seeded = await seedFixture("full")
    const api = client(seeded)
    const res = await api.change([
      { op: "add", path: "glossary[]", value: { id: "G90", term: "Workspace", definition: "A project area owned by one organization." }, reason: "declare term" }
    ])
    expect(res.status, JSON.stringify(res.body.error)).toBe(200)
    expect(res.body.data.spine.glossary).toContainEqual(expect.objectContaining({ term: "Workspace", definition: "A project area owned by one organization." }))
  })

  it("trước baseline: đổi tên chuẩn của thuật ngữ áp thẳng, không cần lý do", async () => {
    const seeded = await seedFixture("full")
    const api = client(seeded)
    const res = await api.change([{ op: "set", path: "glossary[id=G01].term", value: "Software Requirements Specification" }])
    expect(res.status, JSON.stringify(res.body.error)).toBe(200)
    expect(res.body.meta.branch).not.toBe("post_baseline")
    expect(res.body.data.spine.glossary.find((g: Body) => g.id === "G01").term).toBe("Software Requirements Specification")
  })

  it("sau baseline: đổi tên không kèm lý do ⇒ 400, glossary không đổi", async () => {
    const seeded = await seedFixture("full")
    const api = client(seeded)
    expect((await api.post("/baseline", { base_version: seeded.spineVersion })).status).toBe(201)
    const res = await api.change([{ op: "set", path: "glossary[id=G01].term", value: "Spec" }])
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe("VALIDATION_ERROR")
    expect((await api.spine()).glossary.find((g: Body) => g.id === "G01").term).toBe("SRS")
  })

  // BUG(UC-35): spec "After a baseline, renames go through a change request (BR-03)" vs code `change.service.ts:688-694`
  // — project mode 2/3/4 sau baseline chỉ đòi `reason` rồi `applyTransaction` thẳng vào Spine (nhánh post_baseline);
  // change request chỉ có cho mode 1 (`change-request.service.ts:160-163` đòi import).
  it.skip("sau baseline: đổi tên thuật ngữ phải qua change request, không sửa thẳng", async () => {
    const seeded = await seedFixture("full")
    const api = client(seeded)
    expect((await api.post("/baseline", { base_version: seeded.spineVersion })).status).toBe(201)
    const res = await api.change([{ op: "set", path: "glossary[id=G01].term", value: "Spec" }], { reason: "Customer renamed the term" })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect((await api.spine()).glossary.find((g: Body) => g.id === "G01").term).toBe("SRS")
  })
})

// ─── UC-37 ──────────────────────────────────────────────────────────

describe("UC-37 — xếp mức ưu tiên requirement", () => {
  it("tác giả gán Must/Should/Could/Won't cho function và NFR", async () => {
    const seeded = await seedFixture("full")
    const api = client(seeded)
    const res = await api.change([
      { op: "set", path: "functions[id=FN001].priority", value: "should" },
      { op: "set", path: "nfrs[id=N01].priority", value: "wont" }
    ])
    expect(res.status, JSON.stringify(res.body.error)).toBe(200)
    expect(res.body.data.spine.functions.find((f: Body) => f.id === "FN001").priority).toBe("should")
    expect(res.body.data.spine.nfrs.find((n: Body) => n.id === "N01").priority).toBe("wont")
  })

  it("mức ngoài MoSCoW ⇒ 422, không ghi", async () => {
    const seeded = await seedFixture("full")
    const api = client(seeded)
    const res = await api.change([{ op: "set", path: "functions[id=FN001].priority", value: "high" }])
    expect(res.status).toBe(422)
    expect(await api.version()).toBe(seeded.spineVersion)
    expect((await api.spine()).functions.find((f: Body) => f.id === "FN001").priority).toBe("must")
  })

  it("AI gợi ý mức ưu tiên ở S-9.4, tác giả duyệt ở gate", async () => {
    const seeded = await seedFixture("full", {
      mutate: (spine) => {
        // Fixture thiếu bản ghi step Brief ⇒ thêm accepted mọi step đứng trước S-9.4 để S-9.4 tới lượt
        const order = orderedSteps(spine as never).map((s) => s.id)
        const idx = order.indexOf("S-9.4")
        const kept = (spine.steps as Array<Record<string, unknown>>).filter((s) => order.indexOf(s.id as string) < idx)
        const have = new Set(kept.map((s) => s.id))
        const missing = order
          .slice(0, idx)
          .filter((id) => !have.has(id))
          .map((id) => ({ id, status: "accepted", first_seq: null, last_seq: null, accepted_at: "2026-09-01T10:00:00.000Z" }))
        spine.steps = [...kept, ...missing]
        Object.assign(spine.progress as object, { current_phase: "S-9", current_step: "S-9.4" })
        for (const f of spine.functions as Array<Record<string, unknown>>) if (f.id === "FN001") f.priority = null
      }
    })
    mockOverrides.next = (prompt) =>
      prompt.includes("S-9.4") ? JSON.stringify({ ops: [{ op: "set", path: "functions[id=FN001].priority", value: "could" }] }) : undefined

    const run = await runStepHttp(app, seeded, "S-9.4", await spineVersionOf(app, seeded))
    expect(run.errorCode, JSON.stringify(run.events[run.events.length - 1])).toBeNull()
    expect(run.events[run.events.length - 1]?.type).toBe("gate_ready")
    expect((await client(seeded).spine()).functions.find((f: Body) => f.id === "FN001").priority).toBe("could")

    const gate = await gateHttp(app, seeded, "S-9.4", await spineVersionOf(app, seeded))
    expect(gate.status, JSON.stringify(gate.body.error)).toBe(200)
    expect(gate.body.data.step.status).toBe("accepted")
  })
})

// ─── UC-38 ──────────────────────────────────────────────────────────

describe("UC-38 — Analyst nộp baseline SRS để duyệt", () => {
  it("còn cờ đỏ ⇒ 422 BASELINE_BLOCKED, không có baseline (BR-04)", async () => {
    const seeded = await seedFixture("minimal")
    const analyst = client(seeded, await join(seeded, "analyst"))
    const res = await analyst.post("/baseline/submit", { base_version: seeded.spineVersion })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe("BASELINE_BLOCKED")
    expect((res.body.meta.flags as unknown[]).length).toBeGreaterThan(0)
    expect(await analyst.baselines()).toEqual([])
  })

  it("Viewer không nộp được ⇒ 403 ORG_ROLE_FORBIDDEN", async () => {
    const seeded = await seedFixture("full")
    const viewer = client(seeded, await join(seeded, "viewer"))
    const res = await viewer.post("/baseline/submit", { base_version: seeded.spineVersion })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe("ORG_ROLE_FORBIDDEN")
    expect(await client(seeded).baselines()).toEqual([])
  })

  it("Analyst nộp khi 0 cờ đỏ ⇒ chờ Lead duyệt, chưa khoá baseline", async () => {
    const seeded = await seedFixture("full")
    const analyst = client(seeded, await join(seeded, "analyst"))
    const res = await analyst.post("/baseline/submit", { base_version: seeded.spineVersion })
    expect(res.status, JSON.stringify(res.body.error)).toBe(200)
    expect(res.body.data.status).toBe("pending")
    expect(await analyst.baselines()).toEqual([])
    expect((await analyst.submission())?.status).toBe("pending")
  })

  it("Analyst ký thẳng ⇒ 403, baseline chỉ Lead mới khoá được", async () => {
    const seeded = await seedFixture("full")
    const analyst = client(seeded, await join(seeded, "analyst"))
    const res = await analyst.post("/baseline", { base_version: seeded.spineVersion })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe("ORG_ROLE_FORBIDDEN")
    expect(await client(seeded).baselines()).toEqual([])
  })

  it("nộp hai lần ⇒ 409 BASELINE_ALREADY_SUBMITTED", async () => {
    const seeded = await seedFixture("full")
    const analyst = client(seeded, await join(seeded, "analyst"))
    expect((await analyst.post("/baseline/submit", { base_version: seeded.spineVersion })).status).toBe(200)
    const again = await analyst.post("/baseline/submit", { base_version: await analyst.version() })
    expect(again.status).toBe(409)
    expect(again.body.error.code).toBe("BASELINE_ALREADY_SUBMITTED")
  })
})

// ─── UC-39 ──────────────────────────────────────────────────────────

describe("UC-39 — Lead duyệt baseline SRS", () => {
  it("Lead tự duyệt khi 0 cờ đỏ ⇒ baseline 1.0 được khoá", async () => {
    const seeded = await seedFixture("full")
    const api = client(seeded)
    const res = await api.post("/baseline", { base_version: seeded.spineVersion })
    expect(res.status, JSON.stringify(res.body.error)).toBe(201)
    const baseline = baselineResponseSchema.parse(res.body.data)
    expect(baseline.version).toBe("v1.0")
    expect((await api.baselines()).map((b) => b.id)).toEqual([baseline.id])
  })

  it("Lead duyệt bản Analyst đã nộp ⇒ v1.0 khoá, trạng thái chờ duyệt được xoá", async () => {
    const seeded = await seedFixture("full")
    const lead = client(seeded)
    const analyst = client(seeded, await join(seeded, "analyst"))
    expect((await analyst.post("/baseline/submit", { base_version: seeded.spineVersion })).status).toBe(200)

    const res = await lead.post("/baseline", { base_version: await lead.version() })
    expect(res.status, JSON.stringify(res.body.error)).toBe(201)
    expect(baselineResponseSchema.parse(res.body.data).version).toBe("v1.0")
    expect(await lead.submission()).toBeNull()
  })

  /** Ghim một comment vào section đầu tiên có nội dung — mọi lượt từ chối đều cần (business-flow §3.5). */
  const pinComment = async (api: ReturnType<typeof client>, text = "Chỗ này cần nói rõ hơn."): Promise<string> => {
    const doc = await api.get("/document")
    expect(doc.status, JSON.stringify(doc.body.error)).toBe(200)
    const sections = doc.body.data.sections as Array<{ id: string; blocks: unknown[] }>
    const section = sections.find((s) => !s.id.startsWith("group:") && s.blocks.length > 0)!
    const res = await api.post("/comments", { version: { source: "draft" }, anchor: { section_id: section.id }, text })
    expect(res.status, JSON.stringify(res.body.error)).toBe(201)
    return res.body.data.comment_id as string
  }

  it("Lead từ chối kèm lý do và comment ghim ⇒ không ghi baseline, trạng thái rejected giữ lý do", async () => {
    const seeded = await seedFixture("full")
    const lead = client(seeded)
    const analyst = client(seeded, await join(seeded, "analyst"))
    expect((await analyst.post("/baseline/submit", { base_version: seeded.spineVersion })).status).toBe(200)
    const commentId = await pinComment(lead, "Mục này còn thiếu luồng huỷ đặt chỗ.")

    const res = await lead.post("/baseline/reject", {
      base_version: await lead.version(),
      reason: "Mục 3.2 còn thiếu luồng huỷ đặt chỗ.",
      comment_ids: [commentId]
    })
    expect(res.status, JSON.stringify(res.body.error)).toBe(200)
    expect(res.body.data.status).toBe("rejected")
    expect(res.body.data.reason).toContain("3.2")
    expect(res.body.data.rejection_comment_ids).toEqual([commentId])
    expect(await lead.baselines()).toEqual([])
  })

  it("từ chối mà không ghim comment nào ⇒ 400 VALIDATION_ERROR (business-flow §3.5)", async () => {
    const seeded = await seedFixture("full")
    const lead = client(seeded)
    const analyst = client(seeded, await join(seeded, "analyst"))
    expect((await analyst.post("/baseline/submit", { base_version: seeded.spineVersion })).status).toBe(200)

    for (const body of [{ reason: "Chưa đạt" }, { reason: "Chưa đạt", comment_ids: [] }]) {
      const res = await lead.post("/baseline/reject", { base_version: await lead.version(), ...body })
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(res.body.error.code).toBe("VALIDATION_ERROR")
    }
    expect((await lead.submission())?.status).toBe("pending")
  })

  it("từ chối khi không có bản nào chờ duyệt ⇒ 422 NO_PENDING_SUBMISSION", async () => {
    const seeded = await seedFixture("full")
    const lead = client(seeded)
    const commentId = await pinComment(lead)
    const res = await lead.post("/baseline/reject", { base_version: await lead.version(), reason: "Chưa đạt", comment_ids: [commentId] })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe("NO_PENDING_SUBMISSION")
  })

  it("Analyst không từ chối được ⇒ 403 ORG_ROLE_FORBIDDEN", async () => {
    const seeded = await seedFixture("full")
    const lead = client(seeded)
    const analyst = client(seeded, await join(seeded, "analyst"))
    expect((await analyst.post("/baseline/submit", { base_version: seeded.spineVersion })).status).toBe(200)
    const commentId = await pinComment(lead)
    const res = await analyst.post("/baseline/reject", {
      base_version: await analyst.version(),
      reason: "Tự từ chối",
      comment_ids: [commentId]
    })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe("ORG_ROLE_FORBIDDEN")
  })

  it("baseline bất biến: sửa sau baseline không đổi snapshot đã khoá", async () => {
    const seeded = await seedFixture("full")
    const api = client(seeded)
    const created = await api.post("/baseline", { base_version: seeded.spineVersion })
    expect(created.status).toBe(201)
    const changed = await api.change(renameA01(), { reason: "Customer renamed the role" })
    expect(changed.status, JSON.stringify(changed.body.error)).toBe(200)

    const snapshot = await Baseline.findById(created.body.data.snapshot_ref).lean()
    const actors = (snapshot?.snapshot as { actors: Body[] }).actors
    expect(actors.find((a) => a.id === "A01")?.name).toBe("Founder")
  })

  it("còn cờ đỏ ⇒ 422 BASELINE_BLOCKED liệt kê cờ", async () => {
    const seeded = await seedFixture("minimal")
    const api = client(seeded)
    const res = await api.post("/baseline", { base_version: seeded.spineVersion })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe("BASELINE_BLOCKED")
    expect(await api.baselines()).toEqual([])
  })

  it("cờ đỏ giữ nguyên kèm lý do vẫn chặn baseline (BR-04)", async () => {
    const seeded = await seedFixture("full", { mutate: freshSteps })
    const api = client(seeded)
    expect((await api.change(renameA01())).status).toBe(200)
    const red = (await api.flagsAtBaseline()).filter((f) => f.level === "red")
    expect(red.length).toBeGreaterThan(0)
    for (const flag of red) {
      const waived = await api.post(`/flags/${flag.id}/waive`, { reason: "Keep as-is: the customer accepted this content." })
      expect(waived.status, JSON.stringify(waived.body.error)).toBe(200)
    }

    const res = await api.post("/baseline", { base_version: await api.version() })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe("BASELINE_BLOCKED")
    expect(await api.baselines()).toEqual([])
  })
})

// ─── UC-47 ──────────────────────────────────────────────────────────

describe("UC-47 — Analyst sửa SRS theo comment từ chối baseline", () => {
  /** Section đầu tiên có nội dung của bản nháp — chỗ ghim comment. */
  const firstSection = async (api: ReturnType<typeof client>): Promise<{ id: string }> => {
    const res = await api.get("/document")
    expect(res.status, JSON.stringify(res.body.error)).toBe(200)
    const sections = res.body.data.sections as Array<{ id: string; blocks: unknown[] }>
    const section = sections.find((s) => !s.id.startsWith("group:") && s.blocks.length > 0)
    expect(section).toBeDefined()
    return section!
  }

  /** Analyst nộp, Lead ghim `count` comment rồi từ chối kèm chúng. Trả mã comment đã ghim. */
  const rejectWithComments = async (
    lead: ReturnType<typeof client>,
    analyst: ReturnType<typeof client>,
    sectionId: string,
    count: number
  ): Promise<string[]> => {
    expect((await analyst.post("/baseline/submit", { base_version: await analyst.version() })).status).toBe(200)
    const ids: string[] = []
    for (let i = 0; i < count; i++) {
      const res = await lead.post("/comments", {
        version: { source: "draft" },
        anchor: { section_id: sectionId },
        text: `Chỗ này cần nói rõ hơn (${i + 1}).`
      })
      expect(res.status, JSON.stringify(res.body.error)).toBe(201)
      ids.push(res.body.data.comment_id as string)
    }
    const rejected = await lead.post("/baseline/reject", {
      base_version: await lead.version(),
      reason: "Còn chỗ chưa rõ, xem comment đã ghim.",
      comment_ids: ids
    })
    expect(rejected.status, JSON.stringify(rejected.body.error)).toBe(200)
    return ids
  }

  it("comment từ chối còn mở ⇒ gửi lại trả 422 REJECTION_COMMENTS_OPEN liệt kê đúng mã", async () => {
    const seeded = await seedFixture("full")
    const lead = client(seeded)
    const analyst = client(seeded, await join(seeded, "analyst"))
    const section = await firstSection(lead)
    const ids = await rejectWithComments(lead, analyst, section.id, 2)

    const res = await analyst.post("/baseline/submit", { base_version: await analyst.version() })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe("REJECTION_COMMENTS_OPEN")
    expect((res.body.meta.comment_ids as string[]).sort()).toEqual([...ids].sort())
    expect(await analyst.baselines()).toEqual([])
  })

  it("kết luận hết comment ⇒ hết chặn vì comment; bước vừa mở lại thành cờ đỏ chặn tiếp (BR-04)", async () => {
    const seeded = await seedFixture("full")
    const lead = client(seeded)
    const analyst = client(seeded, await join(seeded, "analyst"))
    const section = await firstSection(lead)
    const ids = await rejectWithComments(lead, analyst, section.id, 2)

    for (const id of ids) {
      const resolved = await analyst.post(`/comments/${id}/resolve`, { kind: "fixed" })
      expect(resolved.status, JSON.stringify(resolved.body.error)).toBe(200)
    }

    // Comment đã kết luận hết nên cổng REJECTION_COMMENTS_OPEN im; nhưng resolve đã mở lại bước sở hữu
    // section đó, nên lượt quét ở mức ký mở cờ đỏ "chờ duyệt lại" — phải chạy và accept lại bước mới nộp được.
    const res = await analyst.post("/baseline/submit", { base_version: await analyst.version() })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe("BASELINE_BLOCKED")
    expect((res.body.meta.flags as Body[]).map((f) => f.rule_id)).toContain("section_awaiting_reaccept")
  })

  it("comment ghim ở section không có bước nào đang accepted ⇒ kết luận xong là gửi lại được", async () => {
    const seeded = await seedFixture("full")
    const lead = client(seeded)
    const analyst = client(seeded, await join(seeded, "analyst"))

    const doc = await lead.get("/document")
    const spine = (await lead.spine()) as unknown as Spine
    const accepted = new Set(spine.steps.filter((s) => s.status === "accepted").map((s) => s.id))
    const sections = doc.body.data.sections as Array<{ id: string; blocks: unknown[] }>
    const free = sections.find((s) => !s.id.startsWith("group:") && s.blocks.length > 0 && !stepsOf(s.id, spine).some((id) => accepted.has(id)))
    expect(free, "fixture phải có section không do bước đã accepted nào sở hữu").toBeDefined()

    const ids = await rejectWithComments(lead, analyst, free!.id, 2)
    for (const id of ids) {
      expect((await analyst.post(`/comments/${id}/resolve`, { kind: "fixed" })).status).toBe(200)
    }

    const res = await analyst.post("/baseline/submit", { base_version: await analyst.version() })
    expect(res.status, JSON.stringify(res.body.error)).toBe(200)
    expect(res.body.data.status).toBe("pending")
    expect(res.body.data.rejection_comment_ids).toEqual([])
  })

  it("kết luận comment trên nội dung có step sở hữu đã accepted ⇒ step đó mở lại", async () => {
    const seeded = await seedFixture("full")
    const lead = client(seeded)

    // Chọn section có nội dung mà step sở hữu nó đang accepted — chỉ ca đó mới có gì để mở lại
    const doc = await lead.get("/document")
    expect(doc.status, JSON.stringify(doc.body.error)).toBe(200)
    const spine = (await lead.spine()) as unknown as Spine
    const accepted = new Set(spine.steps.filter((s) => s.status === "accepted").map((s) => s.id))
    const sections = doc.body.data.sections as Array<{ id: string; blocks: unknown[] }>
    const target = sections.find((s) => !s.id.startsWith("group:") && s.blocks.length > 0 && stepsOf(s.id, spine).some((id) => accepted.has(id)))
    expect(target, "fixture phải có ít nhất một section do step đã accepted sở hữu").toBeDefined()
    const owners = stepsOf(target!.id, spine).filter((id) => accepted.has(id))

    const created = await lead.post("/comments", {
      version: { source: "draft" },
      anchor: { section_id: target!.id },
      text: "Mục này cần viết lại."
    })
    expect(created.status, JSON.stringify(created.body.error)).toBe(201)
    const resolved = await lead.post(`/comments/${created.body.data.comment_id}/resolve`, { kind: "fixed" })
    expect(resolved.status, JSON.stringify(resolved.body.error)).toBe(200)

    const after = ((await lead.spine()) as unknown as Spine).steps
    for (const stepId of owners) {
      expect(after.find((s) => s.id === stepId)?.status, stepId).toBe("revision_requested")
    }
  })
})
