/**
 * C-3 tìm vị trí ảnh hưởng (`cr-impact.service.ts`, nút 3.4 + khoá 3.5) trên project đã import (fixture SRS Lumen).
 * FLF-172, plan §8.3. Ca chính: hợp 3 nguồn, khử trùng, `found_by` đúng, `owner_step` đúng. Thêm: tìm lại thay
 * vị trí cũ + trả khoá block bị bỏ, block không sửa được bị loại, sai trạng thái.
 * Hàm thuần `findLocations` có test riêng ở `src/modules/change-request/impact.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import { crDoc, detail, importedProject, lockedBlocks, newCr, resetCrMock } from "../../helpers/mode1-cr-p4.js"
import { fakeCrClarify, fakeCrPropose } from "../../helpers/mode1.js"
import { runImpact } from "../../../src/modules/change-request/cr-impact.service.js"
import { ChangeLocation } from "../../../src/modules/change-request/change-location.model.js"
import { ChangeRequest } from "../../../src/modules/change-request/change-request.model.js"
import { Spine } from "../../../src/modules/spine/spine.model.js"

/** UC-01 (mention), FR-3.2.2 (section + FieldAnchor), từ khoá "Register" + "dashboard". */
const UC_TARGETS = { entity_paths: ["use_cases[id=UC-01].name", "functions[id=FR-3.2.2]"], keywords: ["Register", "dashboard"] }

beforeEach(() => resetCrMock((p) => fakeCrClarify(UC_TARGETS)(p) ?? fakeCrPropose(p)))

const toImpactReview = async () => {
  const ctx = await importedProject()
  const crId = await newCr(ctx.c, "Rename registration", "Rename UC-01 and adjust the login function.")
  detail(await ctx.c.post(`/change-requests/${crId}/clarify`))
  return { ...ctx, crId, cr: `/change-requests/${crId}` }
}

describe("C-3 hợp ba nguồn", () => {
  it("spine_link (section function + FieldAnchor), mention (mã UC trong text), keyword — khử trùng theo block, owner_step theo section", async () => {
    const { c, cr } = await toImpactReview()
    const d = detail(await c.post(`${cr}/impact`))
    expect(d.change_request.status).toBe("impact_review")
    expect(d.locations.map((l) => ({ id: l.location_id, block: l.block_id, by: l.found_by, paths: l.entity_paths, owner: l.owner_step }))).toEqual([
      { id: "L001", block: "B0014", by: ["mention"], paths: ["use_cases[id=UC-01]"], owner: "S-3.6" },
      { id: "L002", block: "B0020", by: ["mention"], paths: ["use_cases[id=UC-01]"], owner: "S-3.2" },
      { id: "L003", block: "B0021", by: ["keyword"], paths: [], owner: "S-3.2" },
      { id: "L004", block: "B0031", by: ["keyword"], paths: [], owner: "S-5.2@nonscreen" },
      { id: "L005", block: "B0032", by: ["mention"], paths: ["use_cases[id=UC-01]"], owner: "S-5.2@nonscreen" },
      { id: "L006", block: "B0033", by: ["spine_link"], paths: ["functions[id=FR-3.2.2]"], owner: "S-5.2@nonscreen" },
      // section function + anchor + từ khoá "dashboard" trên cùng block ⇒ một vị trí
      { id: "L007", block: "B0034", by: ["spine_link", "keyword"], paths: ["functions[id=FR-3.2.2]"], owner: "S-5.2@nonscreen" },
      { id: "L008", block: "B0035", by: ["spine_link"], paths: ["functions[id=FR-3.2.2]"], owner: "S-5.2@nonscreen" }
    ])
    // mọi vị trí bị khoá bởi CR, chưa có kết luận
    expect(d.locations.every((l) => l.block?.locked_by_cr === "CR-001" && l.conclusion === null && l.group_id === null)).toBe(true)
  })

  it("block không sửa được (bảng gộp B0016 dù UC-01 neo vào) và block rỗng không thành vị trí", async () => {
    const { c, cr } = await toImpactReview()
    const d = detail(await c.post(`${cr}/impact`))
    const blocks = d.locations.map((l) => l.block_id)
    expect(blocks).not.toContain("B0016")
    expect(d.locations.every((l) => l.block?.editable && l.block.text !== "")).toBe(true)
  })

  it("path không phải phần tử bị bỏ, từ khoá < 3 ký tự bị bỏ ⇒ 0 vị trí, không khoá gì", async () => {
    const { c, cr, projectId, crId } = await toImpactReview()
    await ChangeRequest.updateOne({ projectId, cr_id: crId }, { $set: { targets: { entity_paths: ["project.vision"], keywords: ["xy"] } } })
    const d = detail(await c.post(`${cr}/impact`))
    expect(d.locations).toEqual([])
    expect(await lockedBlocks(projectId, crId)).toEqual([])
  })
})

describe("C-3 tìm lại", () => {
  it("chạy lại impact với đích hẹp hơn ⇒ thay toàn bộ vị trí, trả khoá block bị bỏ, giữ khoá block còn lại", async () => {
    const { c, cr, projectId, crId } = await toImpactReview()
    detail(await c.post(`${cr}/impact`))
    expect(await lockedBlocks(projectId, crId)).toEqual(["B0014", "B0020", "B0021", "B0031", "B0032", "B0033", "B0034", "B0035"])

    await ChangeRequest.updateOne({ projectId, cr_id: crId }, { $set: { targets: { entity_paths: ["functions[id=FR-3.2.2]"], keywords: [] } } })
    const again = detail(await c.post(`${cr}/impact`))
    expect(again.locations.map((l) => [l.location_id, l.block_id])).toEqual([
      ["L001", "B0033"],
      ["L002", "B0034"],
      ["L003", "B0035"]
    ])
    expect(await lockedBlocks(projectId, crId)).toEqual(["B0033", "B0034", "B0035"])
    expect(await ChangeLocation.countDocuments({ projectId, cr_id: crId })).toBe(3)
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
