/**
 * C-5 kiểm đề xuất (`verify.service.ts`, nút 3.7–3.9, UC-82) trên Mongo thật, provider AI giả.
 * Mode 1 v2 (FLF-186): vị trí là phần tử Spine. Ca chính: giá trị tại path đổi sau khi đề xuất ⇒ 409 CR_VALUE_CHANGED
 * (chặn); op phá bất biến ⇒ đỏ; AI chỉ vàng (gắn theo section); redo ≤ 2 rồi manual_fix. Thêm: vị trí sửa tay trượt ⇒
 * manual_fix ngay, mất khoá ⇒ đỏ, không có thay đổi ⇒ không gọi AI, hết credit ở C-5 ⇒ paused.
 * Hàm thuần `checkLocation` / `checkSpineOps` có test riêng ở `src/modules/change-request/verify.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import { PERF_TARGETS, crDoc, crToImpact, detail, importedProject, promptsOf, resetCrMock, routeCr } from "../../helpers/mode1-cr-p4.js"
import { fakeCrClarify, fakeCrPropose, fakeCrProposeNoChange, promptLocations } from "../../helpers/mode1.js"
import { ChangeLocation } from "../../../src/modules/change-request/change-location.model.js"
import { SpineLock } from "../../../src/modules/change-request/spine-lock.model.js"
import { runVerify } from "../../../src/modules/change-request/verify.service.js"
import { Spine } from "../../../src/modules/spine/spine.model.js"

const NFR = "nfrs[id=NFR-01]"
const BR = "business_rules[id=BR-01]"
const clarifyPerf = fakeCrClarify(PERF_TARGETS)

/** C-4 chuẩn nhưng op của NFR làm Spine sai schema (category lạ). */
const proposeBadOp = (p: string) => {
  if (!p.includes("# CR Propose")) return undefined
  const out = JSON.parse(fakeCrPropose(p)!)
  for (const l of out.locations) if (l.conclusion === "edit") l.spine_ops = [{ op: "set", path: `${NFR}.category`, value: "bogus" }]
  return JSON.stringify(out)
}

beforeEach(() => resetCrMock())

const toProposed = async () => {
  const ctx = await importedProject()
  const { crId, cr } = await crToImpact(ctx.c)
  const proposed = detail(await ctx.c.post(`${cr}/propose`))
  return { ...ctx, crId, cr, proposed }
}

describe("C-5 kiểm code (đỏ)", () => {
  it("giá trị tại path đổi sau khi đề xuất ⇒ 409 CR_VALUE_CHANGED, không lưu kết quả verify, không gọi AI", async () => {
    const { c, projectId, cr } = await toProposed()
    await Spine.updateOne({ projectId, "nfrs.id": "NFR-01" }, { $set: { "nfrs.$.threshold": "3 s" } })
    const res = await c.post(`${cr}/verify`)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("CR_VALUE_CHANGED")
    expect(res.body.meta).toMatchObject({ location_id: "L001", path: NFR })
    expect(await ChangeLocation.countDocuments({ projectId, verify: { $ne: null } })).toBe(0)
    expect(promptsOf("# CR Consistency")).toHaveLength(0)
  })

  it("op Spine làm hỏng Spine ⇒ vị trí đó đỏ, vị trí khác đạt; AI làm lại (proposing, redo_count 1)", async () => {
    routeCr((p) => clarifyPerf(p) ?? proposeBadOp(p))
    const { c, cr } = await toProposed()
    const d = detail(await c.post(`${cr}/verify`))
    expect(d.change_request.status).toBe("proposing")
    const nfr = d.locations.find((l) => l.path === NFR)!
    expect(nfr.verify).toMatchObject({ code_ok: false })
    expect(nfr.verify!.violations.length).toBeGreaterThan(0) // đổi category làm hỏng bất biến / schema
    expect(nfr.redo_count).toBe(1)
    expect(d.locations.find((l) => l.path === BR)).toMatchObject({ verify: { code_ok: true, violations: [] }, redo_count: 0 })
    // AI consistency chỉ nhận vị trí đã qua kiểm code (BR comment)
    const [consistency] = promptsOf("# CR Consistency")
    expect(consistency).toContain(`[L002][${BR}] (comment) Check ${BR}`)
    expect(consistency).not.toContain(`[L001][${NFR}]`)
  })

  it("phần tử mất khoá ⇒ path_not_locked (đỏ)", async () => {
    const { c, projectId, cr } = await toProposed()
    await SpineLock.deleteOne({ projectId, path: BR })
    const d = detail(await c.post(`${cr}/verify`))
    expect(d.locations.find((l) => l.path === BR)!.verify!.violations.map((v) => v.rule)).toEqual(["path_not_locked"])
    expect(d.change_request.status).toBe("proposing")
  })
})

describe("C-5 AI consistency chỉ vàng", () => {
  it("nhận xét AI gắn vào vị trí sửa cùng section (không khớp section ⇒ vị trí đầu), không chặn ⇒ ready_to_submit", async () => {
    routeCr((p) => {
      if (clarifyPerf(p)) return clarifyPerf(p)
      if (p.includes("# CR Consistency"))
        return JSON.stringify({
          findings: [
            { rule: "contradiction", section_id: "fixed:4.2.3", message: "1 second contradicts the SLA table", block_ids: [] },
            { rule: "dangling_reference", section_id: "fixed:5.1", message: "Rule still assumes 2 seconds", block_ids: [] },
            { rule: "term_drift", section_id: "fixed:9.9", message: "Somewhere else", block_ids: [] }
          ]
        })
      return fakeCrPropose(p)
    })
    const { c, cr } = await toProposed()
    const d = detail(await c.post(`${cr}/verify`))
    expect(d.change_request.status).toBe("ready_to_submit")
    expect(d.locations.every((l) => l.verify?.code_ok)).toBe(true)
    const by = (path: string) => d.locations.find((l) => l.path === path)!.verify!.ai_flags.map((f) => f.rule)
    expect(by(NFR)).toEqual(["contradiction", "term_drift"])
    expect(by(BR)).toEqual(["dangling_reference"])
    // prompt: giá trị trước/sau của phần tử sửa, section
    const [prompt] = promptsOf("# CR Consistency")
    expect(prompt).toContain(`[L001][${NFR}] (fixed:4.2.3 Performance)`)
    expect(prompt).toMatch(/before: [\s\S]*"threshold": "2 s"/)
    expect(prompt).toMatch(/after: [\s\S]*"threshold": "1 s"/)
  })

  it("mọi vị trí not_related ⇒ không gọi AI consistency, đạt", async () => {
    routeCr((p) =>
      clarifyPerf(p) ??
      (p.includes("# CR Propose")
        ? JSON.stringify({ locations: promptLocations(p).map((l) => ({ location_id: l.location_id, conclusion: "not_related", reason: "Không liên quan", spine_ops: [] })) })
        : undefined)
    )
    const { c, cr } = await toProposed()
    const d = detail(await c.post(`${cr}/verify`))
    expect(d.change_request.status).toBe("ready_to_submit")
    expect(promptsOf("# CR Consistency")).toHaveLength(0)
    expect(d.groups).toEqual([])
  })

  it("hết credit ở C-5 ⇒ paused credits ở verifying, chưa lưu kết quả; nạp rồi resume ⇒ ready_to_submit", async () => {
    const { c, cr, seeded, projectId } = await toProposed()
    const { CreditWallet } = await import("../../../src/modules/credits/credit-wallet.model.js")
    await CreditWallet.updateOne({ userId: seeded.userId }, { $set: { balance: 0 } })
    const paused = detail(await c.post(`${cr}/verify`))
    expect(paused.change_request).toMatchObject({ status: "verifying", paused: { reason: "credits" } })
    expect(await ChangeLocation.countDocuments({ projectId, verify: { $ne: null } })).toBe(0)
    await CreditWallet.updateOne({ userId: seeded.userId }, { $set: { balance: 100 } })
    const resumed = detail(await c.post(`${cr}/resume`))
    expect(resumed.change_request).toMatchObject({ status: "ready_to_submit", paused: null })
  })
})

describe("C-5 redo ≤ 2 rồi manual_fix", () => {
  it("AI đề xuất trượt 3 lần ⇒ proposing, proposing, manual_fix; redo_count dừng ở 2", async () => {
    routeCr((p) => clarifyPerf(p) ?? fakeCrProposeNoChange(p))
    const { c, cr } = await toProposed()
    const statuses: string[] = []
    const redo: number[] = []
    for (let i = 0; i < 3; i++) {
      if (i > 0) detail(await c.post(`${cr}/propose`))
      const d = detail(await c.post(`${cr}/verify`))
      statuses.push(d.change_request.status)
      redo.push(d.locations.find((l) => l.path === NFR)!.redo_count)
    }
    expect(statuses).toEqual(["proposing", "proposing", "manual_fix"])
    expect(redo).toEqual([1, 2, 2])
    // manual_fix: không cho AI đề xuất nữa, chỉ sửa tay rồi verify
    expect((await c.post(`${cr}/propose`)).body.error.code).toBe("CR_INVALID_TRANSITION")
  })

  it("vị trí sửa tay trượt ⇒ manual_fix ngay, không tăng redo_count; sửa tay đúng ⇒ đạt", async () => {
    const { c, cr } = await toProposed()
    const nfr = detail(await c.get(cr)).locations.find((l) => l.path === NFR)!
    const same = JSON.parse(nfr.current_text)
    detail(await c.patch(`${cr}/locations/${nfr.location_id}`, { conclusion: "edit", new_value: same }))
    const d = detail(await c.post(`${cr}/verify`))
    expect(d.change_request.status).toBe("manual_fix")
    expect(d.locations.find((l) => l.location_id === nfr.location_id)).toMatchObject({ manual: true, redo_count: 0, verify: { code_ok: false } })
    detail(await c.patch(`${cr}/locations/${nfr.location_id}`, { new_value: { ...same, threshold: "1 s" } }))
    expect(detail(await c.post(`${cr}/verify`)).change_request.status).toBe("ready_to_submit")
  })

  it("verify sai trạng thái ⇒ 409; service thiếu Spine ⇒ ném", async () => {
    const { c, projectId } = await importedProject()
    const { crId, cr } = await crToImpact(c)
    expect((await c.post(`${cr}/verify`)).body.error.code).toBe("CR_INVALID_TRANSITION")
    detail(await c.post(`${cr}/propose`))
    await Spine.deleteOne({ projectId })
    await expect(runVerify(await crDoc(projectId, crId), "000000000000000000000000")).rejects.toThrow(/Spine/)
  })
})
