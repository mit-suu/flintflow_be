/**
 * Mode 1 v3 (BPMN 3.1, plan `mode1-v3/phase-2-be-flow3.md` 2.1–2.2): tạo CR kèm bản xem trước của panel "Sửa tài liệu
 * có xem trước" (`preview_id`). Bản xem trước chỉ là **gợi ý** — C-2 thấy lệnh + op, C-3 lấy phần tử bị op chạm làm đích
 * (`found_by: preview`), C-4 thấy op đề xuất của đúng vị trí đó; mọi nút của Flow 3 vẫn chạy.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import { CR_BODY, PERF_TARGETS, detail, importedProject, promptsOf, resetCrMock } from "../../helpers/mode1-cr-p4.js"
import { changeRequestDetailSchema } from "../../../src/modules/change-request/change-request.dto.js"

beforeEach(() => resetCrMock())

const VISION = "Lumen helps small training centers run their courses online."

const previewVision = async (c: Awaited<ReturnType<typeof importedProject>>["c"]) => {
  const res = await c.post("/changes/preview", { base_version: await c.spineVersion(), ops: [{ op: "set", path: "project.vision", value: VISION }] })
  expect(res.status, JSON.stringify(res.body.error)).toBe(200)
  expect(res.body.meta).toMatchObject({ requires_cr: true })
  return res.body.data.preview_id as string
}

describe("CR kèm bản xem trước (preview_id)", () => {
  it("seed lưu ở CR; C-2 thấy bản xem trước; C-3 thêm phần tử bị op chạm (found_by preview); C-4 thấy op gợi ý của vị trí", async () => {
    const { c } = await importedProject()
    const previewId = await previewVision(c)

    const created = await c.post("/change-requests", { title: "Update vision", description: "Make the vision clearer.", ...CR_BODY, preview_id: previewId })
    expect(created.status, JSON.stringify(created.body.error)).toBe(201)
    expect(created.body.meta?.seed_dropped).toBeUndefined()
    const cr0 = changeRequestDetailSchema.parse(created.body.data).change_request
    expect(cr0.seed).toEqual({ instruction: null, ops: [{ op: "set", path: "project.vision", value: VISION }], targets: ["project"] })
    const cr = `/change-requests/${cr0.cr_id}`

    // C-2 vẫn chạy (không bỏ nút) và thấy bản xem trước trong mô tả
    expect(detail(await c.post(`${cr}/clarify`)).change_request.status).toBe("impact_review")
    expect(promptsOf("# CR Clarify").at(-1)).toContain("previewed this change")

    // C-3: đích C-2 (NFR-01) + phần tử của bản xem trước (project); vị trí liên quan khác vẫn được tìm
    const impact = detail(await c.post(`${cr}/impact`))
    const project = impact.locations.find((l) => l.path === "project")
    expect(project?.found_by).toContain("preview")
    expect(impact.locations.some((l) => l.path === PERF_TARGETS.entity_paths[0])).toBe(true)

    // C-4 vẫn gọi AI, prompt có op gợi ý đúng cho vị trí project
    detail(await c.post(`${cr}/propose`))
    const propose = promptsOf("# CR Propose").join("\n")
    expect(propose).toContain("Requester's previewed ops for this location")
    expect(propose).toContain(VISION)
  })

  it("bản xem trước hết hạn / không tồn tại ⇒ CR vẫn tạo, không seed, meta.seed_dropped", async () => {
    const { c } = await importedProject()
    const res = await c.post("/change-requests", { title: "Update vision", description: "Make the vision clearer.", ...CR_BODY, preview_id: "khong-ton-tai" })
    expect(res.status, JSON.stringify(res.body.error)).toBe(201)
    expect(res.body.meta).toMatchObject({ seed_dropped: true })
    expect(changeRequestDetailSchema.parse(res.body.data).change_request.seed).toBeNull()
  })

  it("tạo CR nguồn chat ⇒ 400 (BPMN 3.1 chỉ có 6 nguồn; lệnh trong chat là yêu cầu miệng)", async () => {
    const { c } = await importedProject()
    const res = await c.post("/change-requests", { title: "x", description: "y", source: { kind: "chat", ref: "chat:1" }, requester: "PM Lan" })
    expect(res.status).toBe(400)
  })
})
