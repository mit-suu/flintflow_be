/**
 * C-4 đề xuất cho từng vị trí (`propose.service.ts`, nút 3.6, UC-81) + gom group (`group.service.ts`) + nộp.
 * Mode 1 v2 (FLF-186): vị trí là phần tử Spine (NFR-01, BR-01, mục riêng…), đề xuất = op Spine.
 * Ca chính: chọn đúng skill của owner step; vị trí chưa kết luận chặn submit; gom group theo section.
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

const NFR = "nfrs[id=NFR-01]"
const BR = "business_rules[id=BR-01]"

/** PERF + từ khoá chạm mục riêng "5.9 Team Notes" (không step sở hữu). */
const WIDE_TARGETS = { entity_paths: PERF_TARGETS.entity_paths, keywords: [...PERF_TARGETS.keywords, "Internal notes"] }

const clarifyWide = fakeCrClarify(WIDE_TARGETS)
const clarifyPerf = fakeCrClarify(PERF_TARGETS)

beforeEach(() => resetCrMock())

const skillHead = (step: string): string => getSkill(STEP_SKILLS[step]).template.trim().slice(0, 80)

/** Output C-4: comment mọi vị trí. */
const commentAll = (p: string) =>
  p.includes("# CR Propose")
    ? JSON.stringify({ locations: promptLocations(p).map((l) => ({ location_id: l.location_id, conclusion: "comment", reason: "r", comment_text: `Check ${l.path}`, spine_ops: [] })) })
    : undefined

describe("C-4 chọn skill của owner step", () => {
  it("một lượt gọi mỗi owner step; prompt nạp skill nội dung của đúng step (S-6.4 NFR, S-7.1 phụ lục), chỉ chứa vị trí của step đó", async () => {
    const { c } = await importedProject()
    const { cr, impact } = await crToImpact(c)
    expect(impact.locations.map((l) => [l.path, l.owner_step])).toEqual([
      [NFR, "S-6.4"],
      [BR, "S-7.1"]
    ])
    detail(await c.post(`${cr}/propose`))
    const prompts = promptsOf("# CR Propose")
    expect(prompts).toHaveLength(2)
    const nfr = prompts.find((p) => p.includes(`] ${NFR} (`))!
    const appendix = prompts.find((p) => p.includes(`] ${BR} (`))!
    expect(nfr).toContain(skillHead("S-6.4"))
    expect(nfr).not.toContain(skillHead("S-7.1"))
    expect(promptLocations(nfr).map((l) => l.path)).toEqual([NFR])
    expect(appendix).toContain(skillHead("S-7.1"))
    expect(promptLocations(appendix).map((l) => l.path)).toEqual([BR])
    // prompt có section, lý do tìm thấy, giá trị hiện tại + CR
    expect(nfr).toContain(`[L001] ${NFR} (section: Performance; found by spine_link, keyword; about ${NFR})`)
    expect(promptLocations(nfr)[0].text).toContain("2 seconds")
    expect(nfr).toContain("Response time must be 1 second instead of 2 seconds.")
  })

  it("mục riêng (không step sở hữu) ⇒ skill (none — free-form section …)", async () => {
    routeCr((p) => clarifyWide(p) ?? fakeCrPropose(p))
    const { c } = await importedProject()
    const { cr, impact } = await crToImpact(c)
    const custom = impact.locations.find((l) => l.path.startsWith("custom_sections["))!
    expect(custom).toMatchObject({ owner_step: null, section_title: "5.9 Team Notes" })
    detail(await c.post(`${cr}/propose`))
    const prompts = promptsOf("# CR Propose")
    expect(prompts).toHaveLength(3)
    expect(prompts.find((p) => p.includes(`] ${custom.path} (`))).toContain("(none — free-form section kept verbatim from the uploaded file)")
  })
})

describe("C-4 kết luận mọi vị trí", () => {
  it("model bỏ sót một vị trí ⇒ gọi lại một lần chỉ cho phần thiếu; vẫn thiếu ⇒ conclusion null (chờ sửa tay)", async () => {
    const omitNfr = (p: string) =>
      p.includes("# CR Propose") ? JSON.stringify({ locations: JSON.parse(fakeCrPropose(p)!).locations.filter((_: unknown, i: number) => promptLocations(p)[i].path !== NFR) }) : undefined
    routeCr((p) => clarifyPerf(p) ?? omitNfr(p))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const { c } = await importedProject()
    const { cr } = await crToImpact(c)
    const d = detail(await c.post(`${cr}/propose`))
    const prompts = promptsOf("# CR Propose")
    // S-6.4: lượt đầu + lượt bù chỉ có NFR; S-7.1: một lượt
    expect(prompts).toHaveLength(3)
    expect(promptLocations(prompts[1]).map((l) => l.path)).toEqual([NFR])
    expect(d.locations.find((l) => l.path === NFR)).toMatchObject({ conclusion: null, proposal: null, group_id: null })
    expect(d.locations.filter((l) => l.conclusion !== null)).toHaveLength(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("bỏ sót L001"))
    warn.mockRestore()
  })

  it("lô nhiều vị trí lỗi (model đốt hết ngân sách) ⇒ chia đôi gọi lại từng nửa, CR không bị dừng", async () => {
    const { c } = await importedProject()
    const { cr } = await crToImpact(c)
    // Dựng một lô 2 vị trí: kéo vị trí BR sang cùng owner step với NFR (chỉ để test cách chia lô)
    await ChangeLocation.updateOne({ path: BR }, { $set: { owner_step: "S-6.4" } })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    routeCr((p) => {
      if (!p.includes("# CR Propose")) return clarifyPerf(p)
      return promptLocations(p).length > 1 ? new Error("GLM không trả nội dung (finish_reason=length, max_tokens=10240)") : fakeCrPropose(p)
    })

    const d = detail(await c.post(`${cr}/propose`))

    expect(d.change_request.paused).toBeNull()
    expect(d.locations.every((l) => l.conclusion !== null)).toBe(true)
    const sizes = promptsOf("# CR Propose").map((p) => promptLocations(p).length)
    expect(sizes).toEqual([2, 1, 1]) // lô đầy đủ hỏng ⇒ hai nửa, mỗi nửa một vị trí
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("chia đôi và thử lại"))
    warn.mockRestore()
  })

  it("lượt bù trả đủ ⇒ mọi vị trí có kết luận", async () => {
    let first = true
    routeCr((p) => {
      if (clarifyPerf(p)) return clarifyPerf(p)
      if (!p.includes("# CR Propose")) return undefined
      const out = JSON.parse(fakeCrPropose(p)!)
      if (first && promptLocations(p)[0].path === NFR) {
        first = false
        out.locations = []
      }
      return JSON.stringify(out)
    })
    const { c } = await importedProject()
    const { cr } = await crToImpact(c)
    const d = detail(await c.post(`${cr}/propose`))
    expect(promptsOf("# CR Propose")).toHaveLength(3)
    expect(d.locations.every((l) => l.conclusion !== null)).toBe(true)
  })

  it("model đánh số lại location_id trong lô (trả L001 cho lô L002) ⇒ vẫn ghép theo thứ tự", async () => {
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
    expect(d.locations.find((l) => l.path === BR)).toMatchObject({ location_id: "L002", conclusion: "comment" })
    expect(d.locations.every((l) => l.conclusion !== null)).toBe(true)
  })

  it("edit: BE chụp giá trị trước/sau khi chạy khô op của vị trí", async () => {
    const { c } = await importedProject()
    const { cr } = await crToImpact(c)
    const d = detail(await c.post(`${cr}/propose`))
    const nfr = d.locations.find((l) => l.path === NFR)!
    expect(nfr.conclusion).toBe("edit")
    expect(nfr.proposal?.old_text).toBe(nfr.current_text)
    expect(nfr.proposal?.old_text).toContain("2 seconds")
    expect(nfr.proposal?.new_text).toContain('"threshold": "1 s"')
    expect(nfr.proposal?.spine_ops).toHaveLength(2)
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
  it("theo section của phần tử: một group mỗi section có sửa/ghi chú; not_related không vào group", async () => {
    routeCr((p) => clarifyWide(p) ?? fakeCrPropose(p))
    const { c } = await importedProject()
    const { cr } = await crToImpact(c)
    const d = detail(await c.post(`${cr}/propose`))
    const custom = d.locations.find((l) => l.path.startsWith("custom_sections["))!
    expect(custom).toMatchObject({ conclusion: "not_related", group_id: null })
    expect(d.groups.map((g) => ({ id: g.group_id, title: g.title, locs: g.location_ids.map((id) => d.locations.find((l) => l.location_id === id)!.path), decision: g.decision }))).toEqual([
      { id: "G01", title: "Performance", locs: [NFR], decision: "pending" },
      { id: "G02", title: "Business Rules", locs: [BR], decision: "pending" }
    ])
    for (const g of d.groups) for (const id of g.location_ids) expect(d.locations.find((l) => l.location_id === id)?.group_id).toBe(g.group_id)
  })

  it("mục riêng có ghi chú ⇒ group mang tiêu đề mục riêng", async () => {
    routeCr((p) => clarifyWide(p) ?? commentAll(p))
    const { c } = await importedProject()
    const { cr } = await crToImpact(c)
    const d = detail(await c.post(`${cr}/propose`))
    expect(d.groups.map((g) => g.title)).toEqual(["Performance", "Business Rules", "5.9 Team Notes"])
  })

  it("sửa tay sang not_related rồi nộp ⇒ gom lại: vị trí rời group, group rỗng biến mất", async () => {
    const { c } = await importedProject()
    const { cr, verified } = await crToReady(c)
    const br = verified.locations.find((l) => l.path === BR)!
    const patched = detail(await c.patch(`${cr}/locations/${br.location_id}`, { conclusion: "not_related", reason: "Không phải quy tắc nghiệp vụ" }))
    // sửa sau khi đạt ⇒ về verifying để kiểm lại
    expect(patched.change_request.status).toBe("verifying")
    expect(patched.locations.find((l) => l.location_id === br.location_id)).toMatchObject({ manual: true, verify: null, conclusion: "not_related" })
    expect(detail(await c.post(`${cr}/verify`)).change_request.status).toBe("ready_to_submit")
    const submitted = detail(await c.post(`${cr}/submit`))
    expect(submitted.groups.map((g) => g.title)).toEqual(["Performance"])
    expect(submitted.locations.find((l) => l.location_id === br.location_id)?.group_id).toBeNull()
  })

  it("sửa tay bằng new_value ⇒ op set cả phần tử; giá trị sau hiện trong new_text", async () => {
    const { c } = await importedProject()
    const { cr, impact } = await crToImpact(c)
    const br = impact.locations.find((l) => l.path === BR)!
    const value = { ...JSON.parse(br.current_text), statement: "Passwords must have at least 12 characters." }
    const d = detail(await c.patch(`${cr}/locations/${br.location_id}`, { conclusion: "edit", reason: "Chính sách mới", new_value: value }))
    const loc = d.locations.find((l) => l.location_id === br.location_id)!
    expect(loc.proposal?.spine_ops).toEqual([{ op: "set", path: BR, value }])
    expect(loc.proposal?.new_text).toContain("12 characters")
    expect(loc.manual).toBe(true)
  })
})

describe("C-4 chạy lại", () => {
  it("vị trí sửa tay không bị AI đè; lần làm lại chỉ gửi vị trí trượt kèm lý do trượt", async () => {
    const { c, projectId } = await importedProject()
    const { cr, impact } = await crToImpact(c)
    const br = impact.locations.find((l) => l.path === BR)!
    detail(await c.patch(`${cr}/locations/${br.location_id}`, { conclusion: "comment", comment_text: "Ghi chú tay" }))
    detail(await c.post(`${cr}/propose`))
    expect(promptsOf("# CR Propose").flatMap(promptLocations).map((l) => l.path)).toEqual([NFR])

    // làm trượt NFR: op đặt lại đúng giá trị cũ ⇒ edit_no_change
    const nfr = impact.locations.find((l) => l.path === NFR)!
    await ChangeLocation.updateOne(
      { projectId, path: NFR },
      { $set: { proposal: { old_text: nfr.current_text, new_text: nfr.current_text, comment_text: null, spine_ops: [{ op: "set", path: `${NFR}.threshold`, value: "2 s" }] } } }
    )
    const v = detail(await c.post(`${cr}/verify`))
    expect(v.change_request.status).toBe("proposing")
    const before = promptsOf("# CR Propose").length
    const d = detail(await c.post(`${cr}/propose`))
    const redo = promptsOf("# CR Propose").slice(before)
    expect(redo).toHaveLength(1)
    expect(promptLocations(redo[0]).map((l) => l.path)).toEqual([NFR])
    expect(redo[0]).toContain("Previous proposal failed checks: Op không đổi gì ở phần tử này")
    expect(d.locations.find((l) => l.location_id === br.location_id)).toMatchObject({ manual: true, proposal: { comment_text: "Ghi chú tay" } })
  })

  it("propose sai trạng thái ⇒ 409; thiếu Spine ⇒ ném; PATCH vị trí không có / thiếu kết luận / edit thiếu giá trị ⇒ lỗi", async () => {
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
