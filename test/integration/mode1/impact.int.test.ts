/**
 * C-3 tìm vị trí ảnh hưởng (`cr-impact.service.ts`, nút 3.4 + khoá 3.5) trên project đã import (fixture SRS Lumen).
 * Mode 1 v2 (FLF-186): vị trí là **phần tử Spine** — đích + phần tử tham chiếu tới đích, phần tử nhắc mã/tên đích, từ khoá;
 * khoá theo path. Hàm thuần có test riêng ở `src/modules/change-request/impact.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import { crDoc, detail, importedProject, lockedPaths, newCr, resetCrMock } from "../../helpers/mode1-cr-p4.js"
import { fakeCrClarify, fakeCrPropose } from "../../helpers/mode1.js"
import { runImpact } from "../../../src/modules/change-request/cr-impact.service.js"
import { ChangeLocation } from "../../../src/modules/change-request/change-location.model.js"
import { ChangeRequest } from "../../../src/modules/change-request/change-request.model.js"
import { Spine } from "../../../src/modules/spine/spine.model.js"

const UC_TARGETS = { entity_paths: ["use_cases[id=UC-01].name", "functions[id=FR-3.2.2]"], keywords: ["Register", "dashboard"] }

beforeEach(() => resetCrMock((p) => fakeCrClarify(UC_TARGETS)(p) ?? fakeCrPropose(p)))

const toImpactReview = async () => {
  const ctx = await importedProject()
  const crId = await newCr(ctx.c, "Rename registration", "Rename UC-01 and adjust the login function.")
  detail(await ctx.c.post(`/change-requests/${crId}/clarify`))
  return { ...ctx, crId, cr: `/change-requests/${crId}` }
}

describe("C-3 trên Spine", () => {
  it("đích thành vị trí spine_link, không trùng; section + owner step theo phần tử; mọi vị trí bị CR khoá theo path", async () => {
    const { c, cr, projectId, crId } = await toImpactReview()
    const d = detail(await c.post(`${cr}/impact`))
    expect(d.change_request.status).toBe("impact_review")
    const byPath = new Map(d.locations.map((l) => [l.path, l]))
    expect(byPath.get("use_cases[id=UC-01]")).toMatchObject({ section_id: "fixed:2.2.2", section_title: "Use Case Descriptions", owner_step: "S-3.2" })
    expect(byPath.get("use_cases[id=UC-01]")?.found_by).toContain("spine_link")
    expect(byPath.get("functions[id=FR-3.2.2]")).toMatchObject({ section_id: "function:FR-3.2.2", found_by: expect.arrayContaining(["spine_link"]) })
    expect(new Set(d.locations.map((l) => l.path)).size).toBe(d.locations.length)
    expect(d.locations.map((l) => l.location_id)).toEqual(d.locations.map((_, i) => `L${String(i + 1).padStart(3, "0")}`))
    // giá trị hiện tại của phần tử đi kèm; chưa kết luận
    expect(byPath.get("use_cases[id=UC-01]")?.current_text).toContain('"id": "UC-01"')
    expect(d.locations.every((l) => l.conclusion === null && l.group_id === null)).toBe(true)
    expect(await lockedPaths(projectId, crId)).toEqual(d.locations.map((l) => l.path).sort())
  })

  it("từ khoá tìm trong mọi phần tử (ranh giới từ); phần tử nhắc mã đích ⇒ mention", async () => {
    const { c, cr } = await toImpactReview()
    const d = detail(await c.post(`${cr}/impact`))
    for (const l of d.locations.filter((x) => x.found_by.includes("keyword"))) expect(l.current_text).toMatch(/register|dashboard/i)
    for (const l of d.locations.filter((x) => x.found_by.includes("mention"))) expect(l.current_text).toMatch(/UC-01|FR-3\.2\.2|Register account|Log in to system/)
  })

  it("đích không phải phần tử / không còn, từ khoá < 3 ký tự ⇒ 409 CR_NO_LOCATIONS nói rõ đích, không khoá gì, CR giữ impact_review", async () => {
    const { c, cr, projectId, crId } = await toImpactReview()
    await ChangeRequest.updateOne({ projectId, cr_id: crId }, { $set: { targets: { entity_paths: ["flags", "actors[id=A99]"], keywords: ["xy"] } } })
    const res = await c.post(`${cr}/impact`)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("CR_NO_LOCATIONS")
    expect(res.body.meta).toEqual({ targets: { entity_paths: ["flags", "actors[id=A99]"], keywords: ["xy"] }, empty_sections: [] })
    expect(await lockedPaths(projectId, crId)).toEqual([])
    expect((await crDoc(projectId, crId)).status).toBe("impact_review")
  })

  it("đích là mã section (CR từ gap report) ⇒ mọi phần tử của section đó; section còn trống ⇒ CR_NO_LOCATIONS kèm step để soạn", async () => {
    const { c, cr, projectId, crId } = await toImpactReview()
    // 2.2.2 Use Case Descriptions có phần tử ⇒ mọi use case là vị trí
    await ChangeRequest.updateOne({ projectId, cr_id: crId }, { $set: { targets: { entity_paths: ["fixed:2.2.2"], keywords: [] } } })
    const d = detail(await c.post(`${cr}/impact`))
    expect(d.locations.length).toBeGreaterThan(0)
    for (const l of d.locations) expect(l).toMatchObject({ section_id: "fixed:2.2.2", found_by: ["spine_link"], entity_paths: ["fixed:2.2.2"] })
    expect(await lockedPaths(projectId, crId)).toEqual(d.locations.map((l) => l.path).sort())

    // 3.1.1 Screens Flow: file không có ⇒ trống ⇒ không có gì để sửa, chỉ đường sang step S-4.2
    await ChangeRequest.updateOne({ projectId, cr_id: crId }, { $set: { targets: { entity_paths: ["fixed:3.1.1"], keywords: ["Screens Flow"] } } })
    const res = await c.post(`${cr}/impact`)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("CR_NO_LOCATIONS")
    expect(res.body.error.message).toContain("đang trống")
    expect(res.body.meta.empty_sections).toEqual([{ section_id: "fixed:3.1.1", title: "Screens Flow", step_id: "S-4.2" }])
    // lượt trước đã khoá use case — lượt hỏng không được ghi/đổi gì
    expect(await lockedPaths(projectId, crId)).toEqual(d.locations.map((l) => l.path).sort())
  })
})

describe("C-3 tìm lại", () => {
  it("chạy lại impact với đích hẹp hơn ⇒ thay toàn bộ vị trí, trả khoá phần tử bị bỏ, giữ khoá phần tử còn lại", async () => {
    const { c, cr, projectId, crId } = await toImpactReview()
    const first = detail(await c.post(`${cr}/impact`))
    expect(first.locations.length).toBeGreaterThan(1)

    await ChangeRequest.updateOne({ projectId, cr_id: crId }, { $set: { targets: { entity_paths: ["functions[id=FR-3.2.2]"], keywords: [] } } })
    const again = detail(await c.post(`${cr}/impact`))
    expect(again.locations[0]).toMatchObject({ location_id: "L001", path: "functions[id=FR-3.2.2]" })
    expect(await lockedPaths(projectId, crId)).toEqual(again.locations.map((l) => l.path).sort())
    expect(await ChangeLocation.countDocuments({ projectId, cr_id: crId })).toBe(again.locations.length)
  })

  it("impact ngoài impact_review ⇒ 409; service thiếu Spine ⇒ ném, không ghi vị trí", async () => {
    const { c, cr, projectId } = await toImpactReview()
    detail(await c.post(`${cr}/impact`))
    detail(await c.post(`${cr}/propose`))
    const late = await c.post(`${cr}/impact`)
    expect(late.status).toBe(409)
    expect(late.body.error.code).toBe("CR_INVALID_TRANSITION")

    const other = await newCr(c)
    detail(await c.post(`/change-requests/${other}/clarify`))
    await Spine.deleteOne({ projectId })
    await expect(runImpact(await crDoc(projectId, other))).rejects.toThrow(/Spine/)
    expect(await ChangeLocation.countDocuments({ projectId, cr_id: other })).toBe(0)
  })
})
