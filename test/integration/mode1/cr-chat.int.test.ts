/**
 * Mode 1 v3 phase 8 — CR chạy trong chat: gộp thêm lệnh sửa (`/amend`) ở từng trạng thái, C-3 cộng dồn vị trí,
 * "Sửa lại" một vị trí (`owner-step-draft`) ngoài `manual_fix`. Mongo thật, provider AI giả.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import { PERF_TARGETS, crToReady, crToReview, detail, importedProject, lockedPaths, newCr, promptsOf, resetCrMock, routeCr } from "../../helpers/mode1-cr-p4.js"
import { fakeCrPropose, promptLocations } from "../../helpers/mode1.js"
import { Spine } from "../../../src/modules/spine/spine.model.js"
import { ChangeRequest } from "../../../src/modules/change-request/change-request.model.js"

beforeEach(() => resetCrMock())

const UC = "use_cases[id=UC-02]"

/** C-2 giả: có lệnh gộp thêm nhắc "login" ⇒ đích thêm UC-02; không thì đích hiệu năng như cũ. */
const clarifyWithAmend = (p: string): string | undefined => {
  if (!p.includes("# CR Clarify")) return undefined
  const amended = p.includes("The requester then added") && p.includes("login")
  return JSON.stringify({
    ambiguous: false,
    questions: [],
    targets: amended ? { entity_paths: [...PERF_TARGETS.entity_paths, UC], keywords: PERF_TARGETS.keywords } : PERF_TARGETS
  })
}

describe("phase 8 — gộp thêm lệnh sửa vào CR chưa nộp", () => {
  it("draft ⇒ chỉ ghi lại; bước làm rõ đầu tiên đọc cả lệnh gộp", async () => {
    const { c } = await importedProject()
    const crId = await newCr(c)
    const d = detail(await c.post(`/change-requests/${crId}/amend`, { instruction: "Also cover the login screen" }))
    expect(d.change_request.status).toBe("draft")
    expect(d.change_request.amendments.map((a) => a.text)).toEqual(["Also cover the login screen"])
    expect(promptsOf("# CR Clarify")).toHaveLength(0)
    detail(await c.post(`/change-requests/${crId}/clarify`))
    expect(promptsOf("# CR Clarify")[0]).toContain("The requester then added (all of these are part of the same change request):\n1. Also cover the login screen")
  })

  it("ready_to_submit ⇒ làm rõ lại ⇒ 3.4 giữ vị trí + đề xuất cũ, chỉ thêm + khoá phần tử mới ⇒ 3.6 chỉ đề xuất vị trí mới", async () => {
    routeCr((p) => clarifyWithAmend(p) ?? fakeCrPropose(p))
    const { c, projectId } = await importedProject()
    const { crId, cr, verified } = await crToReady(c)
    const before = verified.locations.map((l) => ({ id: l.location_id, path: l.path, conclusion: l.conclusion, proposal: l.proposal }))

    const amended = detail(await c.post(`${cr}/amend`, { instruction: "Also apply the new threshold to the login use case" }))
    expect(amended.change_request.status).toBe("impact_review")
    // khoá cũ còn nguyên khi quay lại làm rõ
    expect(await lockedPaths(projectId, crId)).toEqual(expect.arrayContaining(before.map((l) => l.path)))

    const impact = detail(await c.post(`${cr}/impact`))
    for (const old of before) expect(impact.locations.find((l) => l.location_id === old.id)).toMatchObject({ path: old.path, conclusion: old.conclusion, proposal: old.proposal })
    const fresh = impact.locations.filter((l) => !before.some((b) => b.id === l.location_id))
    expect(fresh.map((l) => l.path)).toContain(UC)
    expect(fresh.every((l) => l.conclusion === null)).toBe(true)
    expect(await lockedPaths(projectId, crId)).toContain(UC)

    const proposeCalls = promptsOf("# CR Propose").length
    detail(await c.post(`${cr}/propose`))
    const newPrompts = promptsOf("# CR Propose").slice(proposeCalls)
    const asked = newPrompts.flatMap((p) => promptLocations(p).map((l) => l.location_id))
    expect(asked.sort()).toEqual(fresh.map((l) => l.location_id).sort())
    expect(detail(await c.post(`${cr}/verify`)).change_request.status).toBe("ready_to_submit")
  })

  it("đang chờ trả lời / đã nộp ⇒ 409 CR_INVALID_TRANSITION", async () => {
    const { c } = await importedProject()
    const waiting = await newCr(c, "Change the login", "AMBIGUOUS-CR: change the login somehow.")
    detail(await c.post(`/change-requests/${waiting}/clarify`))
    const r1 = await c.post(`/change-requests/${waiting}/amend`, { instruction: "x y z" })
    expect(r1.status).toBe(409)
    expect(r1.body.error.code).toBe("CR_INVALID_TRANSITION")

    const { cr } = await crToReview(c)
    const r2 = await c.post(`${cr}/amend`, { instruction: "x y z" })
    expect(r2.body.error.code).toBe("CR_INVALID_TRANSITION")
  })
})

describe("phase 8 — \"Sửa lại\" một vị trí theo hướng người dùng", () => {
  it("ready_to_submit ⇒ soạn lại vị trí, ghi đề xuất (manual), CR về verifying; impact_review ⇒ 409", async () => {
    const { c } = await importedProject()
    const early = await newCr(c)
    detail(await c.post(`/change-requests/${early}/clarify`))
    const impact = detail(await c.post(`/change-requests/${early}/impact`))
    const tooEarly = await c.post(`/change-requests/${early}/locations/${impact.locations[0].location_id}/owner-step-draft`, { instruction: "Ngưỡng 1 giây" })
    expect(tooEarly.body.error.code).toBe("CR_INVALID_TRANSITION")
    detail(await c.post(`/change-requests/${early}/cancel`, { reason: "Chỉ để thử trạng thái sớm" }))

    const { cr, verified } = await crToReady(c)
    const loc = verified.locations.find((l) => l.conclusion === "edit")!
    const redone = detail(await c.post(`${cr}/locations/${loc.location_id}/owner-step-draft`, { instruction: "Ngưỡng 1 giây cho 95% request" }))
    expect(redone.change_request.status).toBe("verifying")
    expect(redone.locations.find((l) => l.location_id === loc.location_id)).toMatchObject({ manual: true, verify: null })
    expect(promptsOf("# CR Propose").at(-1)).toContain("Ngưỡng 1 giây cho 95% request")
    expect(detail(await c.post(`${cr}/verify`)).change_request.status).toBe("ready_to_submit")
  })
})

describe("CR cần phần tử chưa có (2026-09-24: CR thêm bảng vào mục ERD đã có dữ liệu chỉ ra comment)", () => {
  it("đích `entities[]` ⇒ ô thêm mới (ADD NEW, kèm thực thể có sẵn) ⇒ AI thêm thực thể ⇒ kiểm đạt ⇒ duyệt ⇒ thực thể vào tài liệu", async () => {
    const NEW = { id: "E-99", name: "Quyền truy cập màn hình", description: "Cặp người dùng – màn hình do Điều phối viên gán / thu hồi", relations: [] }
    routeCr((p) => {
      if (p.includes("# CR Clarify")) return JSON.stringify({ ambiguous: false, questions: [], targets: { entity_paths: ["entities[]", "fixed:3.1.5"], keywords: [] } })
      if (!p.includes("# CR Propose")) return undefined
      return JSON.stringify({
        locations: promptLocations(p).map((l) =>
          l.path === "entities[]"
            ? { location_id: l.location_id, conclusion: "edit", reason: "CR cần lưu quyền truy cập màn hình", spine_ops: [{ op: "add", path: "entities[]", value: NEW }], assumptions: [] }
            : { location_id: l.location_id, conclusion: "not_related", reason: "Thực thể này không đổi", spine_ops: [] }
        )
      })
    })
    const { c, projectId } = await importedProject()
    // mục ERD đã có dữ liệu (đúng ca người dùng gặp: thêm bảng vào mục có sẵn)
    await Spine.updateOne({ projectId }, { $push: { entities: { id: "E-01", name: "Đơn đặt", description: "Đơn đặt món", relations: [] } } })
    const crId = await newCr(c, "Phân quyền màn hình", "Điều phối viên gán / thu hồi quyền truy cập từng màn hình cho người dùng — cần bảng lưu quyền.")
    const cr = `/change-requests/${crId}`
    detail(await c.post(`${cr}/clarify`))
    const impact = detail(await c.post(`${cr}/impact`))
    const slot = impact.locations.find((l) => l.path === "entities[]")
    expect(slot).toMatchObject({ section_id: "fixed:3.1.5", found_by: ["spine_link"] })

    const existing = (await c.get("/spine")).body.data.entities as unknown[]
    detail(await c.post(`${cr}/propose`))
    const prompt = promptsOf("# CR Propose").find((p) => p.includes("] entities[] ("))!
    // mục đã có thực thể ⇒ ADD NEW (thêm thứ chưa có, phần tử cũ là vị trí riêng); chưa có ⇒ EMPTY SECTION
    expect(prompt).toContain(existing.length ? "ADD NEW" : "EMPTY SECTION")
    expect(existing.length).toBeGreaterThan(0)
    expect(prompt).toContain("Đơn đặt") // thực thể có sẵn hiện trong ô thêm mới để AI nối mã, tránh trùng
    const verified = detail(await c.post(`${cr}/verify`))
    expect(verified.change_request.status).toBe("ready_to_submit")
    expect(verified.locations.find((l) => l.path === "entities[]")?.proposal?.new_text).toContain("Quyền truy cập màn hình")

    const submitted = detail(await c.post(`${cr}/submit`))
    let last = submitted
    for (const g of submitted.groups) last = detail(await c.post(`${cr}/groups/${g.group_id}/decision`, { decision: "approved", reason: "Đúng yêu cầu của khách", base_version: await c.spineVersion() }))
    expect(last.change_request.status).toBe("written")
    const spine = (await c.get("/spine")).body.data
    expect(spine.entities.map((e: { id: string }) => e.id)).toEqual(["E-01", "E-99"])
  })
})

describe("CR gọi tên mục (2026-09-24, CR-008: \"tạo bảng cho phần 3.1.3 Screen Authorization\" ⇒ nội dung rơi vào NFR-07)", () => {
  it("model bỏ qua mục được nêu ⇒ code vẫn nhắm mục đó (bỏ từ khoá lan man), có ô thêm mới, mọi lô C-4 biết chỗ thêm; thêm từ vị trí khác ⇒ 3.7 chặn", async () => {
    routeCr((p) => {
      // model giống lần chạy thật: chỉ trả NFR + tác nhân + từ khoá, không có mục 3.1.3
      if (p.includes("# CR Clarify"))
        return JSON.stringify({ ambiguous: false, questions: [], targets: { entity_paths: ["nfrs[id=NFR-01]", "actors[id=A01]"], keywords: ["Passwords", "2 seconds"] } })
      if (!p.includes("# CR Propose")) return undefined
      return JSON.stringify({
        locations: promptLocations(p).map((l) =>
          l.path.startsWith("actors[")
            ? // AI "lách": chèn bảng thành mục riêng mới từ vị trí tác nhân
              { location_id: l.location_id, conclusion: "edit", reason: "Thêm bảng phân quyền", spine_ops: [{ op: "add", path: "custom_sections[]", value: { id: "CS99", heading: "Phân quyền", level: 3, source: "manual", blocks: [] } }], assumptions: [] }
            : { location_id: l.location_id, conclusion: "not_related", reason: "Không liên quan", spine_ops: [] }
        )
      })
    })
    const { c, projectId } = await importedProject()
    const crId = await newCr(c, "tạo bảng cho phần 3.1.3 Screen Authorization", "tạo bảng cho phần 3.1.3 Screen Authorization")
    const cr = `/change-requests/${crId}`
    detail(await c.post(`${cr}/clarify`))
    const doc = await ChangeRequest.findOne({ projectId, cr_id: crId }).lean()
    expect(doc!.targets.entity_paths).toContain("fixed:3.1.3")
    expect(doc!.targets.keywords).toEqual([])

    const impact = detail(await c.post(`${cr}/impact`))
    const paths = impact.locations.map((l) => l.path)
    expect(paths).toEqual(expect.arrayContaining(["roles[]", "permissions[]", "nfrs[id=NFR-01]", "actors[id=A01]"]))

    detail(await c.post(`${cr}/propose`))
    const prompts = promptsOf("# CR Propose")
    expect(prompts.length).toBeGreaterThan(1)
    for (const p of prompts) {
      expect(p).toContain("Sections this change targets:")
      expect(p).toContain("location permissions[]")
    }
    const verified = detail(await c.post(`${cr}/verify`))
    const actor = verified.locations.find((l) => l.path === "actors[id=A01]")!
    expect(actor.verify?.code_ok).toBe(false)
    expect(actor.verify?.violations.map((v) => v.rule)).toContain("add_outside_slot")
  })
})

describe("Bảng phân quyền màn hình (2026-09-24: CR chỉ thêm vai trò ⇒ tài liệu không hiện gì)", () => {
  it("vai trò (liên kết tác nhân có sẵn) + quyền tham chiếu vai trò thêm cùng CR ⇒ kiểm đạt ⇒ duyệt ⇒ Spine có đủ vai trò + quyền (ma trận render: section-renderer.test)", async () => {
    routeCr((p) => {
      if (p.includes("# CR Clarify")) return JSON.stringify({ ambiguous: false, questions: [], targets: { entity_paths: ["fixed:3.1.3"], keywords: [] } })
      if (!p.includes("# CR Propose")) return undefined
      return JSON.stringify({
        locations: promptLocations(p).map((l) =>
          l.path === "roles[]"
            ? { location_id: l.location_id, conclusion: "edit", reason: "Thêm vai trò", spine_ops: [{ op: "add", path: "roles[]", value: { id: "R01", name: "Learner", actor_id: "A01" } }], assumptions: [] }
            : l.path === "permissions[]"
              ? { location_id: l.location_id, conclusion: "edit", reason: "Ma trận quyền", spine_ops: [{ op: "add", path: "permissions[]", value: { id: "P01", screen_id: "SCR-01", role_id: "R01", action: "view" } }], assumptions: [] }
              : { location_id: l.location_id, conclusion: "not_related", reason: "Không đổi", spine_ops: [] }
        )
      })
    })
    const { c, projectId } = await importedProject()
    const spine0 = (await c.get("/spine")).body.data
    expect(spine0.actors.map((a: { id: string }) => a.id)).toContain("A01")
    expect(spine0.screens.map((s: { id: string }) => s.id)).toContain("SCR-01")
    const crId = await newCr(c, "thêm bảng phần 3.1.3 Screen Authorization", "thêm bảng phần 3.1.3 Screen Authorization")
    const cr = `/change-requests/${crId}`
    detail(await c.post(`${cr}/clarify`))
    detail(await c.post(`${cr}/impact`))
    detail(await c.post(`${cr}/propose`))
    expect(detail(await c.post(`${cr}/verify`)).change_request.status).toBe("ready_to_submit")
    const submitted = detail(await c.post(`${cr}/submit`))
    let last = submitted
    for (const g of submitted.groups) last = detail(await c.post(`${cr}/groups/${g.group_id}/decision`, { decision: "approved", reason: "Đúng yêu cầu của khách", base_version: await c.spineVersion() }))
    expect(last.change_request.status).toBe("written")
    const spine = (await Spine.findOne({ projectId }).lean())!
    expect(spine.roles).toEqual([{ id: "R01", name: "Learner", actor_id: "A01" }])
    expect(spine.permissions).toEqual([{ id: "P01", screen_id: "SCR-01", role_id: "R01", action: "view" }])
  })
})
