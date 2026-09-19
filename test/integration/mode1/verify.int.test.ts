/**
 * C-5 kiểm đề xuất (`verify.service.ts`, nút 3.7–3.9, UC-82) trên Mongo thật, provider AI giả. FLF-172, plan §8.3.
 * Ca chính: old text lệch ⇒ đỏ (409 CR_OLD_TEXT_MISMATCH, chặn); op phá bất biến ⇒ đỏ; AI chỉ vàng; redo ≤ 2 rồi
 * manual_fix. Thêm: vị trí sửa tay trượt ⇒ manual_fix ngay, mất khoá ⇒ đỏ, không có thay đổi ⇒ không gọi AI,
 * hết credit ở C-5 ⇒ paused.
 * Hàm thuần `checkLocation` / `checkSpineOps` có test riêng ở `src/modules/change-request/verify.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import { PERF_TARGETS, crDoc, crToImpact, detail, importedProject, promptsOf, resetCrMock, routeCr } from "../../helpers/mode1-cr-p4.js"
import { fakeCrClarify, fakeCrPropose, fakeCrProposeNoChange, promptLocations } from "../../helpers/mode1.js"
import { textHash } from "../../../src/modules/docx-ooxml/index.js"
import { DocBlock } from "../../../src/modules/import/doc-block.model.js"
import { ChangeLocation } from "../../../src/modules/change-request/change-location.model.js"
import { runVerify } from "../../../src/modules/change-request/verify.service.js"
import { Spine } from "../../../src/modules/spine/spine.model.js"

const clarifyPerf = fakeCrClarify(PERF_TARGETS)
const PERF_TEXT = "The system shall respond within 2 seconds for 95% of requests."

/** C-4 chuẩn nhưng op Spine của câu perf trỏ phần tử không tồn tại ⇒ phá bất biến. */
const proposeBadOp = (p: string) => {
  if (!p.includes("# CR Propose")) return undefined
  const out = JSON.parse(fakeCrPropose(p)!)
  for (const l of out.locations) if (l.conclusion === "edit") l.spine_ops = [{ op: "set", path: "use_cases[id=UC-01].actor_ids", value: ["A99"] }]
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
  it("old text lệch (block đổi sau khi đề xuất) ⇒ 409 CR_OLD_TEXT_MISMATCH, không lưu kết quả verify", async () => {
    const { c, projectId, cr } = await toProposed()
    const changed = "The system shall respond within 3 seconds for 95% of requests."
    await DocBlock.updateOne({ projectId, doc_version: "0.0", block_id: "B0039" }, { $set: { text: changed, text_hash: textHash(changed) } })
    const res = await c.post(`${cr}/verify`)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("CR_OLD_TEXT_MISMATCH")
    expect(res.body.meta).toMatchObject({ location_id: "L002", block_id: "B0039" })
    expect(await ChangeLocation.countDocuments({ projectId, verify: { $ne: null } })).toBe(0)
    // không gọi AI consistency khi kiểm code đã chặn
    expect(promptsOf("# CR Consistency")).toHaveLength(0)
  })

  it("op Spine phá bất biến (khoá chết) ⇒ vị trí đó đỏ, vị trí khác đạt; AI làm lại (proposing, redo_count 1)", async () => {
    routeCr((p) => clarifyPerf(p) ?? proposeBadOp(p))
    const { c, cr } = await toProposed()
    const d = detail(await c.post(`${cr}/verify`))
    expect(d.change_request.status).toBe("proposing")
    const perf = d.locations.find((l) => l.block_id === "B0039")!
    expect(perf.verify).toMatchObject({ code_ok: false })
    expect(perf.verify!.violations[0]).toMatchObject({ rule: "invariant_3_dead_reference", path: "use_cases[id=UC-01].actor_ids[=A99]" })
    expect(perf.redo_count).toBe(1)
    for (const l of d.locations.filter((x) => x.block_id !== "B0039")) expect(l).toMatchObject({ verify: { code_ok: true, violations: [] }, redo_count: 0 })
    // AI consistency chỉ nhận vị trí đã qua kiểm code (hai heading comment)
    const [consistency] = promptsOf("# CR Consistency")
    expect(consistency).toContain("[L001][B0038]")
    expect(consistency).not.toContain("[L002][B0039]")
  })

  it("block mất khoá ⇒ block_not_locked (đỏ)", async () => {
    const { c, projectId, cr } = await toProposed()
    await DocBlock.updateOne({ projectId, doc_version: "0.0", block_id: "B0041" }, { $set: { locked_by_cr: null } })
    const d = detail(await c.post(`${cr}/verify`))
    expect(d.locations.find((l) => l.block_id === "B0041")!.verify!.violations.map((v) => v.rule)).toEqual(["block_not_locked"])
    expect(d.change_request.status).toBe("proposing")
  })
})

describe("C-5 AI consistency chỉ vàng", () => {
  it("nhận xét AI gắn vào vị trí được trỏ (hoặc vị trí đầu nếu trỏ block hàng xóm), không chặn ⇒ ready_to_submit", async () => {
    routeCr((p) => {
      if (clarifyPerf(p)) return clarifyPerf(p)
      if (p.includes("# CR Consistency"))
        return JSON.stringify({
          findings: [
            { rule: "contradiction", section_id: "fixed:4.2.3", message: "1 second contradicts the SLA table", block_ids: ["B0039"] },
            { rule: "dangling_reference", section_id: "fixed:5", message: "Neighbour still says 2 seconds", block_ids: ["B0040"] }
          ]
        })
      return fakeCrPropose(p)
    })
    const { c, cr } = await toProposed()
    const d = detail(await c.post(`${cr}/verify`))
    expect(d.change_request.status).toBe("ready_to_submit")
    expect(d.locations.every((l) => l.verify?.code_ok)).toBe(true)
    const by = (b: string) => d.locations.find((l) => l.block_id === b)!.verify!.ai_flags.map((f) => f.rule)
    expect(by("B0039")).toEqual(["contradiction"])
    // B0040 là hàng xóm, không phải vị trí sửa ⇒ gắn vào vị trí thay đổi đầu tiên (B0038)
    expect(by("B0038")).toEqual(["dangling_reference"])
    expect(by("B0041")).toEqual([])
    // prompt: đề xuất before → after + block hàng xóm
    const [prompt] = promptsOf("# CR Consistency")
    expect(prompt).toContain(`[L002][B0039] ${PERF_TEXT} → The system shall respond within 1 second for 95% of requests.`)
    expect(prompt).toContain('[L001][B0038] 4.2.3 Performance → (comment) Check "4.2.3 Performance"')
    expect(prompt).toContain("[B0037] (-) 4.2 Quality Attributes")
    expect(prompt).toContain("[B0040] (-) 5 Requirement Appendix")
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
      redo.push(d.locations.find((l) => l.block_id === "B0039")!.redo_count)
    }
    expect(statuses).toEqual(["proposing", "proposing", "manual_fix"])
    expect(redo).toEqual([1, 2, 2])
    // manual_fix: không cho AI đề xuất nữa, chỉ sửa tay rồi verify
    expect((await c.post(`${cr}/propose`)).body.error.code).toBe("CR_INVALID_TRANSITION")
  })

  it("vị trí sửa tay trượt ⇒ manual_fix ngay, không tăng redo_count", async () => {
    const { c, cr } = await toProposed()
    const perf = detail(await c.get(cr)).locations.find((l) => l.block_id === "B0039")!
    detail(await c.patch(`${cr}/locations/${perf.location_id}`, { conclusion: "edit", new_text: PERF_TEXT }))
    const d = detail(await c.post(`${cr}/verify`))
    expect(d.change_request.status).toBe("manual_fix")
    expect(d.locations.find((l) => l.location_id === perf.location_id)).toMatchObject({ manual: true, redo_count: 0, verify: { code_ok: false } })
    // sửa tay đúng ⇒ đạt
    detail(await c.patch(`${cr}/locations/${perf.location_id}`, { new_text: "The system shall respond within 1 second for 95% of requests." }))
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
