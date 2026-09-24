/**
 * Mode 1 v3 phase 7 — CR thiếu thông tin: tài liệu bổ sung (dán ở 3.1, upload khi trả lời 3.3), C-2 hỏi dữ kiện
 * thiếu, câu trả lời trống, `missing_info` khi buộc đi tiếp, C-4 ghi giả định. Mongo thật, provider AI giả.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import { CR_BODY, PERF_TARGETS, detail, importedProject, promptsOf, prompts, resetCrMock, routeCr } from "../../helpers/mode1-cr-p4.js"
import { fakeCrPropose } from "../../helpers/mode1.js"
import { mockImages } from "../../helpers/mock-llm.js"
import { CR_MAX_MATERIALS } from "../../../src/modules/change-request/change-request.constants.js"
import { changeRequestDetailSchema } from "../../../src/modules/change-request/change-request.dto.js"
import { Usage } from "../../../src/modules/spine/usage.model.js"

beforeEach(() => resetCrMock())

const MISSING_QUESTION = "Mục hiệu năng cần thời gian phản hồi tối đa bao nhiêu giây?"
const STILL_MISSING = "Số người dùng đồng thời"

/**
 * C-2 giả: CR "bổ sung hiệu năng" chỉ rõ khi prompt có ngưỡng (từ tài liệu `THRESHOLD`). Có ngưỡng ⇒ đi tiếp nhưng
 * còn thiếu số người dùng đồng thời (`missing_info`). C-4 giả: như `fakeCrPropose`, vị trí `edit` kèm giả định.
 */
const factsRoute = (p: string): string | undefined => {
  if (p.includes("# CR Clarify")) {
    const hasThreshold = p.slice(p.indexOf("Source material attached by the user")).includes("THRESHOLD")
    return hasThreshold
      ? JSON.stringify({ ambiguous: false, questions: [], missing_info: [STILL_MISSING], targets: PERF_TARGETS })
      : JSON.stringify({ ambiguous: true, questions: [MISSING_QUESTION], suggestions: [[" ≤ 2 giây ", "≤ 3 giây", "≤ 2 giây"], ["thừa"]], missing_info: [], targets: { entity_paths: [], keywords: [] } })
  }
  if (p.includes("# CR Propose")) {
    const out = JSON.parse(fakeCrPropose(p)!) as { locations: { conclusion: string; assumptions?: string[] }[] }
    for (const l of out.locations) if (l.conclusion === "edit") l.assumptions = ["Giả định 500 người dùng đồng thời"]
    return JSON.stringify(out)
  }
  if (p.includes("# Read Change Request Material Image")) return JSON.stringify({ text: "THRESHOLD 1 second\n\nDescription: ảnh chụp biên bản." })
  return undefined
}

const createCr = async (c: Awaited<ReturnType<typeof importedProject>>["c"], materials?: { name: string; text: string }[]) => {
  const res = await c.post("/change-requests", { title: "Bổ sung yêu cầu hiệu năng", description: "Gap report: thiếu ngưỡng hiệu năng.", ...CR_BODY, ...(materials ? { materials } : {}) })
  expect(res.status, JSON.stringify(res.body.error)).toBe(201)
  return changeRequestDetailSchema.parse(res.body.data)
}

describe("phase 7 — hỏi dữ kiện thiếu, bổ sung tài liệu, giả định", () => {
  it("3.1 dán tài liệu ⇒ 3.2 hỏi dữ kiện ⇒ upload file + để trống câu trả lời ⇒ 3.2 đi tiếp kèm missing_info ⇒ 3.6 ghi giả định", async () => {
    routeCr(factsRoute)
    const { c, projectId } = await importedProject()
    const created = await createCr(c, [{ name: "Email PM", text: "Khách muốn hệ thống nhanh hơn." }])
    const crId = created.change_request.cr_id
    const cr = `/change-requests/${crId}`
    expect(created.change_request.materials).toMatchObject([{ material_id: "M01", kind: "text", name: "Email PM", round: 0, truncated: false }])
    expect(created.change_request.missing_info).toEqual([])

    // 3.2: tài liệu chưa có ngưỡng ⇒ hỏi đúng dữ kiện thiếu; prompt có tài liệu đã dán
    const asked = detail(await c.post(`${cr}/clarify`))
    expect(asked.change_request.status).toBe("awaiting_answers")
    expect(asked.pending_questions).toEqual([MISSING_QUESTION])
    // gợi ý song song câu hỏi: bỏ khoảng trắng + trùng, cắt phần thừa
    expect(asked.change_request.clarifications[0].suggestions).toEqual([["≤ 2 giây", "≤ 3 giây"]])
    expect(promptsOf("# CR Clarify")[0]).toContain("[M01] Email PM (attached when the CR was logged)\nKhách muốn hệ thống nhanh hơn.")

    // 3.3: upload file biên bản (tên tiếng Việt) — gắn với vòng 1
    const up = await c.upload(Buffer.from("Biên bản 23/09\r\nTHRESHOLD 1 second cho 95% request\n\n\n\nhết"), "biên-bản.txt", `${cr}/materials`)
    expect(up.status, JSON.stringify(up.body.error)).toBe(201)
    const withFile = changeRequestDetailSchema.parse(up.body.data)
    expect(withFile.change_request.materials[1]).toMatchObject({ material_id: "M02", kind: "file", name: "biên-bản.txt", round: 1, text: "Biên bản 23/09\nTHRESHOLD 1 second cho 95% request\n\nhết" })
    expect(withFile.pending_questions).toEqual([MISSING_QUESTION])

    // câu trả lời trống ⇒ C-2 chạy lại: thấy "(no answer — unknown)" + tài liệu mới ⇒ đi tiếp, lưu dữ kiện còn thiếu
    const answered = detail(await c.post(`${cr}/answers`, { answers: [""] }))
    expect(answered.change_request.status).toBe("impact_review")
    expect(answered.change_request.missing_info).toEqual([STILL_MISSING])
    const second = promptsOf("# CR Clarify")[1]
    expect(second).toContain(`Q1.1: ${MISSING_QUESTION}\nA: (no answer — unknown)`)
    expect(second).toContain("[M02] biên-bản.txt (attached with the answers of round 1)")

    // qua 3.4 thì không đính kèm nữa
    const late = await c.post(`${cr}/materials`, { name: "Muộn", text: "x" })
    expect(late.status).toBe(409)
    expect(late.body.error.code).toBe("CR_INVALID_TRANSITION")

    // 3.4 ⇒ 3.6: prompt C-4 có tài liệu + dữ kiện thiếu; giả định lưu theo vị trí
    detail(await c.post(`${cr}/impact`))
    const proposed = detail(await c.post(`${cr}/propose`))
    const [propose] = promptsOf("# CR Propose")
    expect(propose).toContain("THRESHOLD 1 second")
    expect(propose).toContain(`Facts the clarify step reported as still missing: - ${STILL_MISSING}`)
    const edits = proposed.locations.filter((l) => l.conclusion === "edit")
    expect(edits.length).toBeGreaterThan(0)
    for (const l of edits) expect(l.proposal?.assumptions).toEqual(["Giả định 500 người dùng đồng thời"])
    for (const l of proposed.locations.filter((x) => x.conclusion !== "edit")) expect(l.proposal?.assumptions).toEqual([])
    expect(await Usage.countDocuments({ projectId, step_id: `C-2:${crId}` })).toBe(2)
  })

  it("ảnh ⇒ Gemini chép chữ (ảnh đi kèm prompt, 1 lượt usage C-1); CR rõ ngay nhờ chữ trong ảnh", async () => {
    routeCr(factsRoute)
    const { c, projectId } = await importedProject()
    const crId = (await createCr(c)).change_request.cr_id
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)])
    const up = await c.upload(png, "notes.png", `/change-requests/${crId}/materials`)
    expect(up.status, JSON.stringify(up.body.error)).toBe(201)
    const d = changeRequestDetailSchema.parse(up.body.data)
    expect(d.change_request.materials).toMatchObject([{ material_id: "M01", kind: "image", name: "notes.png", round: 0, text: "THRESHOLD 1 second\n\nDescription: ảnh chụp biên bản." }])
    const imagePromptIndex = prompts.findIndex((p) => p.includes("# Read Change Request Material Image"))
    expect(imagePromptIndex).toBeGreaterThanOrEqual(0)
    expect(prompts[imagePromptIndex]).toContain("Change request: Bổ sung yêu cầu hiệu năng")
    expect(mockImages.flat()).toContainEqual({ mime: "image/png", bytes: png.length })
    expect(await Usage.countDocuments({ projectId, step_id: `C-1:${crId}` })).toBe(1)

    const clarified = detail(await c.post(`/change-requests/${crId}/clarify`))
    expect(clarified.change_request.status).toBe("impact_review")
  })

  it("định dạng lạ ⇒ 422 CR_MATERIAL_UNSUPPORTED; file không có chữ ⇒ 422 CR_MATERIAL_EMPTY; không lưu gì", async () => {
    const { c } = await importedProject()
    const crId = (await createCr(c)).change_request.cr_id
    const zip = await c.upload(Buffer.from("PK\u0003\u0004 not a doc"), "data.zip", `/change-requests/${crId}/materials`)
    expect(zip.status).toBe(422)
    expect(zip.body.error.code).toBe("CR_MATERIAL_UNSUPPORTED")
    const blank = await c.upload(Buffer.from("  \n\n "), "trống.txt", `/change-requests/${crId}/materials`)
    expect(blank.status).toBe(422)
    expect(blank.body.error.code).toBe("CR_MATERIAL_EMPTY")
    expect(detail(await c.get(`/change-requests/${crId}`)).change_request.materials).toEqual([])
  })

  it(`tối đa ${CR_MAX_MATERIALS} tài liệu ⇒ 409 CR_MATERIAL_LIMIT; xoá được ⇒ id mới không trùng; xoá id lạ ⇒ 404`, async () => {
    const { c } = await importedProject()
    const crId = (await createCr(c)).change_request.cr_id
    const cr = `/change-requests/${crId}`
    for (let i = 1; i <= CR_MAX_MATERIALS; i++) expect((await c.post(`${cr}/materials`, { name: `Đoạn ${i}`, text: `nội dung ${i}` })).status).toBe(201)
    const over = await c.post(`${cr}/materials`, { name: "Thừa", text: "x" })
    expect(over.status).toBe(409)
    expect(over.body.error.code).toBe("CR_MATERIAL_LIMIT")

    const del = await c.del(`${cr}/materials/M03`)
    expect(del.status, JSON.stringify(del.body.error)).toBe(200)
    expect(changeRequestDetailSchema.parse(del.body.data).change_request.materials.map((m) => m.material_id)).not.toContain("M03")
    const again = changeRequestDetailSchema.parse((await c.post(`${cr}/materials`, { name: "Mới", text: "y" })).body.data)
    expect(again.change_request.materials.at(-1)?.material_id).toBe(`M${CR_MAX_MATERIALS + 1}`)
    const missing = await c.del(`${cr}/materials/M99`)
    expect(missing.status).toBe(404)
    expect(missing.body.error.code).toBe("CR_MATERIAL_NOT_FOUND")
  })
})
