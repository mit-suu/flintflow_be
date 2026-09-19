/**
 * C-4 đề xuất cho từng vị trí (`propose.service.ts`, nút 3.6, UC-81) + gom group (`group.service.ts`) + nộp.
 * FLF-172, plan §8.3. Ca chính: chọn đúng skill của owner step; vị trí chưa kết luận chặn submit; gom group.
 * Thêm: model bỏ sót ⇒ gọi lại riêng phần thiếu, vẫn thiếu ⇒ để trống; model đánh số lại; vị trí sửa tay không bị đè;
 * lần làm lại chỉ gửi vị trí trượt; PATCH vị trí.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import { PERF_TARGETS, crDoc, crToImpact, crToReady, detail, importedProject, promptsOf, resetCrMock, routeCr } from "../../helpers/mode1-cr-p4.js"
import { fakeCrClarify, fakeCrPropose, promptLocations } from "../../helpers/mode1.js"
import { getSkill } from "../../../src/shared/ai/prompt-registry.service.js"
import { STEP_SKILLS } from "../../../src/modules/pipeline/context-projection.js"
import { runPropose } from "../../../src/modules/change-request/propose.service.js"
import { submitCr } from "../../../src/modules/change-request/change-request.service.js"
import { ChangeRequest } from "../../../src/modules/change-request/change-request.model.js"
import { ChangeLocation } from "../../../src/modules/change-request/change-location.model.js"
import { Spine } from "../../../src/modules/spine/spine.model.js"

/** PERF + từ khoá chạm "5.9 Team Notes" (B0048, section null) + "UC-01 and UC-02" (B0014, owner S-3.6 không có skill). */
const WIDE_TARGETS = { entity_paths: PERF_TARGETS.entity_paths, keywords: [...PERF_TARGETS.keywords, "Internal notes", "diagram shows"] }

const clarifyWide = fakeCrClarify(WIDE_TARGETS)
const clarifyPerf = fakeCrClarify(PERF_TARGETS)

beforeEach(() => resetCrMock())

const skillHead = (step: string): string => getSkill(STEP_SKILLS[step]).template.trim().slice(0, 80)

/** Output C-4: comment mọi vị trí (để cả block không section cũng vào group). */
const commentAll = (p: string) =>
  p.includes("# CR Propose")
    ? JSON.stringify({ locations: promptLocations(p).map((l) => ({ location_id: l.location_id, conclusion: "comment", reason: "r", comment_text: `Check ${l.block_id}`, spine_ops: [] })) })
    : undefined

describe("C-4 chọn skill của owner step", () => {
  it("một lượt gọi mỗi owner step; prompt nạp skill nội dung của đúng step (S-6.4 NFR, S-7.1 phụ lục), chỉ chứa vị trí của step đó", async () => {
    const { c } = await importedProject()
    const { cr, impact } = await crToImpact(c)
    expect(impact.locations.map((l) => [l.block_id, l.owner_step])).toEqual([
      ["B0038", "S-6.4"],
      ["B0039", "S-6.4"],
      ["B0041", "S-7.1"]
    ])
    detail(await c.post(`${cr}/propose`))
    const prompts = promptsOf("# CR Propose")
    expect(prompts).toHaveLength(2)
    const nfr = prompts.find((p) => p.includes("[B0039]"))!
    const appendix = prompts.find((p) => p.includes("[B0041]"))!
    expect(nfr).toContain(skillHead("S-6.4"))
    expect(nfr).not.toContain(skillHead("S-7.1"))
    expect(promptLocations(nfr).map((l) => l.block_id)).toEqual(["B0038", "B0039"])
    expect(appendix).toContain(skillHead("S-7.1"))
    expect(promptLocations(appendix).map((l) => l.block_id)).toEqual(["B0041"])
    // prompt có lý do tìm thấy + CR
    expect(nfr).toContain("found by spine_link, keyword; about nfrs[id=NFR-01]")
    expect(nfr).toContain("Response time must be 1 second instead of 2 seconds.")
  })

  it("owner step không có skill ⇒ (none); văn xuôi không gắn section ⇒ (none — prose …)", async () => {
    routeCr((p) => clarifyWide(p) ?? fakeCrPropose(p))
    const { c } = await importedProject()
    const { cr, impact } = await crToImpact(c)
    expect(impact.locations.find((l) => l.block_id === "B0048")?.owner_step).toBeNull()
    expect(impact.locations.find((l) => l.block_id === "B0014")?.owner_step).toBe("S-3.6")
    detail(await c.post(`${cr}/propose`))
    const prompts = promptsOf("# CR Propose")
    expect(prompts).toHaveLength(4)
    expect(prompts.find((p) => p.includes("[B0048]"))).toContain("(none — prose not tied to a structured field)")
    const s36 = prompts.find((p) => p.includes("[B0014]"))!
    expect(s36).toMatch(/\(none\)/)
    expect(s36).not.toContain("(none — prose")
  })
})

describe("C-4 kết luận mọi vị trí", () => {
  it("model bỏ sót một vị trí ⇒ gọi lại một lần chỉ cho phần thiếu; vẫn thiếu ⇒ conclusion null (chờ sửa tay)", async () => {
    const omitB0039 = (p: string) =>
      p.includes("# CR Propose") ? JSON.stringify({ locations: JSON.parse(fakeCrPropose(p)!).locations.filter((_: unknown, i: number) => promptLocations(p)[i].block_id !== "B0039") }) : undefined
    routeCr((p) => clarifyPerf(p) ?? omitB0039(p))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const { c } = await importedProject()
    const { cr } = await crToImpact(c)
    const d = detail(await c.post(`${cr}/propose`))
    const prompts = promptsOf("# CR Propose")
    // S-6.4: lượt đầu + lượt bù chỉ có B0039; S-7.1: một lượt
    expect(prompts).toHaveLength(3)
    expect(promptLocations(prompts[1]).map((l) => l.block_id)).toEqual(["B0039"])
    expect(d.locations.find((l) => l.block_id === "B0039")).toMatchObject({ conclusion: null, proposal: null, group_id: null })
    expect(d.locations.filter((l) => l.conclusion !== null)).toHaveLength(2)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("bỏ sót L002"))
    warn.mockRestore()
  })

  it("lượt bù trả đủ ⇒ mọi vị trí có kết luận", async () => {
    let first = true
    routeCr((p) => {
      if (clarifyPerf(p)) return clarifyPerf(p)
      if (!p.includes("# CR Propose")) return undefined
      const out = JSON.parse(fakeCrPropose(p)!)
      if (first && promptLocations(p).length === 2) {
        first = false
        out.locations = out.locations.slice(0, 1)
      }
      return JSON.stringify(out)
    })
    const { c } = await importedProject()
    const { cr } = await crToImpact(c)
    const d = detail(await c.post(`${cr}/propose`))
    expect(promptsOf("# CR Propose")).toHaveLength(3)
    expect(d.locations.every((l) => l.conclusion !== null)).toBe(true)
  })

  it("model đánh số lại location_id trong lô (trả L001 cho lô L003) ⇒ vẫn ghép theo thứ tự", async () => {
    routeCr((p) => {
      if (clarifyPerf(p)) return clarifyPerf(p)
      if (!p.includes("# CR Propose")) return undefined
      const out = JSON.parse(fakeCrPropose(p)!)
      out.locations = out.locations.map((l: { location_id: string }, i: number) => ({ ...l, location_id: `L${String(i + 1).padStart(3, "0")}` }))
      return JSON.stringify(out)
    })
    const { c } = await importedProject()
    const { cr } = await crToImpact(c)
    const d = detail(await c.post(`${cr}/propose`))
    expect(d.locations.find((l) => l.block_id === "B0041")).toMatchObject({ location_id: "L003", conclusion: "comment" })
    expect(d.locations.every((l) => l.conclusion !== null)).toBe(true)
  })

  it("vị trí chưa kết luận chặn submit ⇒ 409 CR_LOCATION_UNCONCLUDED kèm location_ids, CR giữ nguyên", async () => {
    const { c, projectId } = await importedProject()
    const { crId, cr } = await crToReady(c)
    await ChangeLocation.updateOne({ projectId, cr_id: crId, location_id: "L002" }, { $set: { conclusion: null } })
    const res = await c.post(`${cr}/submit`)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("CR_LOCATION_UNCONCLUDED")
    expect(res.body.meta.location_ids).toEqual(["L002"])
    const after = await crDoc(projectId, crId)
    expect(after.status).toBe("ready_to_submit")
    expect(after.submitted_at).toBeNull()
    await expect(submitCr(after)).rejects.toMatchObject({ code: "CR_LOCATION_UNCONCLUDED" })
  })
})

describe("gom change group", () => {
  it("theo section của block: edit + comment cùng section ⇒ một group; not_related không vào group", async () => {
    routeCr((p) => clarifyWide(p) ?? fakeCrPropose(p))
    const { c } = await importedProject()
    const { cr } = await crToImpact(c)
    const d = detail(await c.post(`${cr}/propose`))
    const conclusion = (b: string) => d.locations.find((l) => l.block_id === b)!
    expect(conclusion("B0048")).toMatchObject({ conclusion: "not_related", group_id: null })
    expect(conclusion("B0014")).toMatchObject({ conclusion: "not_related", group_id: null })
    expect(d.groups.map((g) => ({ id: g.group_id, title: g.title, locs: g.location_ids.map((id) => d.locations.find((l) => l.location_id === id)!.block_id), decision: g.decision }))).toEqual([
      { id: "G01", title: "Performance", locs: ["B0038", "B0039"], decision: "pending" },
      { id: "G02", title: "Business Rules", locs: ["B0041"], decision: "pending" }
    ])
    for (const g of d.groups) for (const id of g.location_ids) expect(d.locations.find((l) => l.location_id === id)?.group_id).toBe(g.group_id)
  })

  it("block không section có sửa/ghi chú ⇒ group \"Khác\"", async () => {
    routeCr((p) => clarifyWide(p) ?? commentAll(p))
    const { c } = await importedProject()
    const { cr } = await crToImpact(c)
    const d = detail(await c.post(`${cr}/propose`))
    const misc = d.groups.find((g) => g.title === "Khác")!
    expect(misc.location_ids.map((id) => d.locations.find((l) => l.location_id === id)!.block_id)).toEqual(["B0048"])
    expect(d.groups.map((g) => g.title)).toEqual(["Use Case Diagram", "Performance", "Business Rules", "Khác"])
  })

  it("sửa tay sang not_related rồi nộp ⇒ gom lại: vị trí rời group, group rỗng biến mất", async () => {
    const { c } = await importedProject()
    const { cr, verified } = await crToReady(c)
    const br = verified.locations.find((l) => l.block_id === "B0041")!
    const patched = detail(await c.patch(`${cr}/locations/${br.location_id}`, { conclusion: "not_related", reason: "Không phải quy tắc nghiệp vụ" }))
    // sửa sau khi đạt ⇒ về verifying để kiểm lại
    expect(patched.change_request.status).toBe("verifying")
    expect(patched.locations.find((l) => l.location_id === br.location_id)).toMatchObject({ manual: true, verify: null, conclusion: "not_related" })
    expect(detail(await c.post(`${cr}/verify`)).change_request.status).toBe("ready_to_submit")
    const submitted = detail(await c.post(`${cr}/submit`))
    expect(submitted.groups.map((g) => g.title)).toEqual(["Performance"])
    expect(submitted.locations.find((l) => l.location_id === br.location_id)?.group_id).toBeNull()
  })
})

describe("C-4 chạy lại", () => {
  it("vị trí sửa tay không bị AI đè; lần làm lại chỉ gửi vị trí trượt kèm lý do trượt", async () => {
    const { c, projectId } = await importedProject()
    const { cr, impact } = await crToImpact(c)
    const heading = impact.locations.find((l) => l.block_id === "B0041")!
    detail(await c.patch(`${cr}/locations/${heading.location_id}`, { conclusion: "comment", comment_text: "Ghi chú tay" }))
    detail(await c.post(`${cr}/propose`))
    expect(promptsOf("# CR Propose").flatMap(promptLocations).map((l) => l.block_id)).toEqual(["B0038", "B0039"])

    // làm trượt B0039: đề xuất edit không đổi text
    await ChangeLocation.updateOne({ projectId, block_id: "B0038" }, { $set: { conclusion: "comment", proposal: { old_text: "4.2.3 Performance", new_text: null, comment_text: "ok", spine_ops: [] } } })
    await ChangeLocation.updateOne({ projectId, block_id: "B0039" }, { $set: { proposal: { old_text: "The system shall respond within 2 seconds for 95% of requests.", new_text: "The system shall respond within 2 seconds for 95% of requests.", comment_text: null, spine_ops: [] } } })
    const v = detail(await c.post(`${cr}/verify`))
    expect(v.change_request.status).toBe("proposing")
    const before = promptsOf("# CR Propose").length
    const d = detail(await c.post(`${cr}/propose`))
    const redo = promptsOf("# CR Propose").slice(before)
    expect(redo).toHaveLength(1)
    expect(promptLocations(redo[0]).map((l) => l.block_id)).toEqual(["B0039"])
    expect(redo[0]).toContain("Previous proposal failed checks: new_text giống hệt text hiện tại")
    expect(d.locations.find((l) => l.location_id === heading.location_id)).toMatchObject({ manual: true, proposal: { comment_text: "Ghi chú tay" } })
  })

  it("propose sai trạng thái ⇒ 409; thiếu Spine ⇒ ném; PATCH vị trí không có / thiếu kết luận ⇒ lỗi", async () => {
    const { c, projectId } = await importedProject()
    const { crId, cr } = await crToImpact(c)
    const missing = await c.patch(`${cr}/locations/L099`, { conclusion: "not_related", reason: "Không liên quan" })
    expect(missing.status).toBe(404)
    expect(missing.body.error.code).toBe("CR_LOCATION_NOT_FOUND")
    const noConclusion = await c.patch(`${cr}/locations/L001`, { reason: "Chỉ ghi lý do" })
    expect(noConclusion.status).toBe(409)
    expect(noConclusion.body.error.code).toBe("CR_LOCATION_UNCONCLUDED")
    expect((await c.patch(`${cr}/locations/L001`, { conclusion: "edit" })).status).toBe(400)

    await ChangeRequest.updateOne({ projectId, cr_id: crId }, { $set: { status: "draft" } })
    expect((await c.post(`${cr}/propose`)).body.error.code).toBe("CR_INVALID_TRANSITION")
    await ChangeRequest.updateOne({ projectId, cr_id: crId }, { $set: { status: "impact_review" } })
    await Spine.deleteOne({ projectId })
    await expect(runPropose(await crDoc(projectId, crId), "000000000000000000000000")).rejects.toThrow(/Spine/)
  })
})
