/**
 * C-1 tạo change request + vòng đời lõi (`change-request.service.ts`) trên Mongo thật. FLF-172, plan §8.3.
 * Ca chính: thiếu source/requester ⇒ 400; chưa có baseline ⇒ CR_REQUIRES_BASELINE; `cr_id` tăng dần, không trùng
 * khi tạo đồng thời. Thêm: đọc/lọc, chuyển trạng thái sai, huỷ.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import { seedFixture } from "../../setup.js"
import { createMode1Project, mode1Api } from "../../helpers/mode1.js"
import { CR_BODY, crDoc, crToImpact, detail, importedProject, lockedBlocks, newCr, resetCrMock } from "../../helpers/mode1-cr-p4.js"
import { makeSrsDocx } from "../../../src/modules/import/testing/srs-fixture.js"
import { changeRequestDetailSchema, listChangeRequestsResponseSchema } from "../../../src/modules/change-request/change-request.dto.js"
import * as crService from "../../../src/modules/change-request/change-request.service.js"
import { ChangeRequest, CrCounter } from "../../../src/modules/change-request/change-request.model.js"
import { ImportedDocument } from "../../../src/modules/import/imported-document.model.js"

beforeEach(() => resetCrMock())

const body = (over: Record<string, unknown> = {}) => ({ title: "Faster response time", description: "Response time must be 1 second.", ...CR_BODY, ...over })

describe("C-1 tạo CR — kiểm đầu vào", () => {
  it("thiếu source / thiếu requester / requester rỗng ⇒ 400 CR_SOURCE_REQUIRED; nguồn lạ ⇒ 400 VALIDATION_ERROR; không tạo gì", async () => {
    const { c, projectId } = await importedProject()
    const { source: _s, ...noSource } = body()
    const { requester: _r, ...noRequester } = body()
    for (const b of [noSource, noRequester, body({ requester: "   " }), body({ requester: 42 })]) {
      const res = await c.post("/change-requests", b)
      expect(res.status, JSON.stringify(b)).toBe(400)
      expect(res.body.error.code).toBe("CR_SOURCE_REQUIRED")
    }
    const badKind = await c.post("/change-requests", body({ source: { kind: "rumour" } }))
    expect(badKind.status).toBe(400)
    expect(badKind.body.error.code).toBe("VALIDATION_ERROR")
    const extra = await c.post("/change-requests", body({ priority: "high" }))
    expect(extra.status).toBe(400)
    expect(await ChangeRequest.countDocuments({ projectId })).toBe(0)
    // lượt bị từ chối không ăn số
    expect(await newCr(c)).toBe("CR-001")
  })

  it("nguồn đủ: ref/note mặc định null, status draft, base_doc_version = version mới nhất, import ⇒ change_requested", async () => {
    const { c, projectId } = await importedProject()
    const res = await c.post("/change-requests", body({ source: { kind: "verbal" } }))
    expect(res.status, JSON.stringify(res.body.error)).toBe(201)
    const d = changeRequestDetailSchema.parse(res.body.data)
    expect(d.change_request).toMatchObject({
      cr_id: "CR-001",
      status: "draft",
      source: { kind: "verbal", ref: null, note: null },
      requester: "PM Lan",
      base_doc_version: "0.0",
      paused: null,
      result_doc_version: null
    })
    expect(d.locations).toEqual([])
    expect(d.pending_questions).toEqual([])
    expect((await ImportedDocument.findOne({ projectId }).lean())?.status).toBe("change_requested")
  })
})

describe("C-1 BR-03 — phải có baseline", () => {
  it("project chưa import ⇒ 409 CR_REQUIRES_BASELINE (HTTP + service)", async () => {
    const seeded = await seedFixture("minimal")
    const projectId = await createMode1Project(seeded)
    const res = await mode1Api(seeded, projectId).post("/change-requests", body())
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("CR_REQUIRES_BASELINE")
    await expect(crService.createCr(projectId, seeded.userId, body() as never)).rejects.toMatchObject({ code: "CR_REQUIRES_BASELINE", statusCode: 409 })
    expect(await CrCounter.countDocuments({ projectId })).toBe(0)
  })

  it("import đang dở (đã upload + xác nhận, chưa finalize) ⇒ vẫn CR_REQUIRES_BASELINE", async () => {
    const seeded = await seedFixture("minimal")
    const projectId = await createMode1Project(seeded)
    const c = mode1Api(seeded, projectId)
    const id = (await c.upload(await makeSrsDocx())).body.data.import.id as string
    await c.post("/import/confirm-latest", { import_id: id })
    const res = await c.post("/change-requests", body())
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("CR_REQUIRES_BASELINE")
  })
})

describe("C-1 cr_id tăng dần theo project", () => {
  it("tuần tự: CR-001, CR-002, CR-003; project khác đếm lại từ CR-001", async () => {
    const a = await importedProject()
    expect([await newCr(a.c), await newCr(a.c), await newCr(a.c)]).toEqual(["CR-001", "CR-002", "CR-003"])
    const b = await importedProject()
    expect(await newCr(b.c)).toBe("CR-001")
    expect((await CrCounter.findOne({ projectId: a.projectId }).lean())?.seq).toBe(3)
  })

  it("tạo đồng thời 10 CR (service) ⇒ 10 cr_id khác nhau, liên tiếp CR-001…CR-010", async () => {
    const { projectId, seeded } = await importedProject()
    const crs = await Promise.all(Array.from({ length: 10 }, (_, i) => crService.createCr(projectId, seeded.userId, body({ title: `CR song song ${i}` }) as never)))
    const ids = crs.map((cr) => cr.cr_id).sort()
    expect(new Set(ids).size).toBe(10)
    expect(ids).toEqual(Array.from({ length: 10 }, (_, i) => `CR-${String(i + 1).padStart(3, "0")}`))
    expect(await ChangeRequest.countDocuments({ projectId })).toBe(10)
  })

  it("tạo đồng thời qua HTTP ⇒ mọi request 201, cr_id không trùng", async () => {
    const { c } = await importedProject()
    const res = await Promise.all(Array.from({ length: 6 }, (_, i) => c.post("/change-requests", body({ title: `HTTP ${i}` }))))
    expect(res.map((r) => r.status)).toEqual(Array(6).fill(201))
    const ids = res.map((r) => r.body.data.change_request.cr_id as string)
    expect(new Set(ids).size).toBe(6)
    const list = listChangeRequestsResponseSchema.parse((await c.get("/change-requests")).body.data)
    expect(list.map((x) => x.cr_id).sort()).toEqual([...ids].sort())
  })
})

describe("đọc, lọc, chuyển trạng thái, huỷ", () => {
  it("GET list lọc theo status; CR không tồn tại ⇒ 404 CR_NOT_FOUND", async () => {
    const { c } = await importedProject()
    await newCr(c)
    const second = await newCr(c)
    detail(await c.post(`/change-requests/${second}/clarify`))
    const drafts = listChangeRequestsResponseSchema.parse((await c.get("/change-requests?status=draft")).body.data)
    expect(drafts.map((x) => x.cr_id)).toEqual(["CR-001"])
    const review = listChangeRequestsResponseSchema.parse((await c.get("/change-requests?status=impact_review")).body.data)
    expect(review.map((x) => x.cr_id)).toEqual(["CR-002"])
    const missing = await c.get("/change-requests/CR-099")
    expect(missing.status).toBe(404)
    expect(missing.body.error.code).toBe("CR_NOT_FOUND")
    expect((await c.get("/change-requests/CR-1")).status).toBe(400)
  })

  it("hành động sai trạng thái ⇒ 409 CR_INVALID_TRANSITION kèm status + allowed", async () => {
    const { c, projectId } = await importedProject()
    const crId = await newCr(c)
    for (const path of ["submit", "revise", "impact", "propose", "verify", "resume"]) {
      const res = await c.post(`/change-requests/${crId}/${path}`)
      expect(res.status, path).toBe(409)
      expect(res.body.error.code).toBe("CR_INVALID_TRANSITION")
      expect(res.body.meta.status).toBe("draft")
    }
    const close = await c.post(`/change-requests/${crId}/close`, { reason: "Không cần nữa rồi" })
    expect(close.status).toBe(409)
    // service: transitionCr sang chính nó là no-op; sang trạng thái không có cạnh ⇒ ném
    const cr = await crDoc(projectId, crId)
    await crService.transitionCr(cr, "draft")
    await expect(crService.transitionCr(cr, "written")).rejects.toMatchObject({ code: "CR_INVALID_TRANSITION" })
  })

  it("huỷ CR đang giữ khoá ⇒ cancelled + lý do, mở khoá; huỷ lần hai (trạng thái cuối) ⇒ 409", async () => {
    const { c, projectId } = await importedProject()
    const { crId, cr } = await crToImpact(c)
    expect((await lockedBlocks(projectId, crId)).length).toBeGreaterThan(0)
    const cancelled = detail(await c.post(`${cr}/cancel`, { reason: "Khách hàng rút yêu cầu" }))
    expect(cancelled.change_request).toMatchObject({ status: "cancelled", closed_reason: "Khách hàng rút yêu cầu", paused: null })
    expect(await lockedBlocks(projectId, crId)).toEqual([])
    const again = await c.post(`${cr}/cancel`, { reason: "Khách hàng rút yêu cầu" })
    expect(again.status).toBe(409)
    expect(again.body.error.code).toBe("CR_INVALID_TRANSITION")
    expect((await c.post(`${cr}/cancel`, { reason: "ngắn" })).status).toBe(400)
  })

  it("huỷ CR đang paused (hết credit ở C-2) ⇒ cancelled, bỏ paused", async () => {
    const { c, seeded } = await importedProject()
    const crId = await newCr(c)
    const { CreditWallet } = await import("../../../src/modules/credits/credit-wallet.model.js")
    await CreditWallet.updateOne({ userId: seeded.userId }, { $set: { balance: 0 } })
    const paused = detail(await c.post(`/change-requests/${crId}/clarify`))
    expect(paused.change_request).toMatchObject({ status: "clarifying", paused: { reason: "credits" } })
    const cancelled = detail(await c.post(`/change-requests/${crId}/cancel`, { reason: "Hết ngân sách credit" }))
    expect(cancelled.change_request).toMatchObject({ status: "cancelled", paused: null })
  })
})
