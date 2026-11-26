import { beforeEach, describe, expect, it, vi } from "vitest"
import { createEmptySpine } from "../spine/spine.repository.js"

const h = vi.hoisted(() => ({
  profile: {} as Record<string, unknown>,
  spine: null as unknown,
  update: vi.fn(async () => ({})),
  steps: [] as { id: string; status: string }[]
}))

vi.mock("../project/project.model.js", async (orig) => ({ ...(await orig<typeof import("../project/project.model.js")>()), Project: { findById: () => ({ lean: async () => ({ mode: "fpt", template_intent: "free" }) }) } }))
vi.mock("./template-profile.model.js", async (orig) => ({ ...(await orig<typeof import("./template-profile.model.js")>()), TemplateProfile: { findOne: () => ({ lean: async () => h.profile }), updateOne: h.update } }))
vi.mock("../render/rendered-document.model.js", async (orig) => ({ ...(await orig<typeof import("../render/rendered-document.model.js")>()), RenderedDocumentCache: { deleteMany: async () => ({}) } }))
vi.mock("../render/assemble.service.js", async (orig) => ({ ...(await orig<typeof import("../render/assemble.service.js")>()), loadTemplateLayout: async () => ({ layout: [] }) }))
vi.mock("../render/layout-sections.js", async (orig) => ({ ...(await orig<typeof import("../render/layout-sections.js")>()), placeSections: () => [] }))
vi.mock("../spine/spine.repository.js", async (orig) => ({ ...(await orig<typeof import("../spine/spine.repository.js")>()), get: async () => h.spine }))

import { assertLayoutConfirmedForBaseline, confirmLayout } from "./layout-preview.service.js"

const base = () => ({
  flow2_entry_at: new Date(),
  layout_confirmed_at: null,
  target_structure: { resolved_mode: 4, sections: [{ section_id: "fixed:V.5", status: "missing", title: "Yêu cầu", owner_steps: ["S-4.1"] }] }
})

describe("layout-preview - FLF-461 BF 2.9a", () => {
  beforeEach(() => {
    h.update.mockClear()
    h.profile = base()
    h.spine = { ...createEmptySpine({ name: "X" }), steps: [{ id: "S-4.1", status: "drafting" }] }
  })
  it("còn mục chưa soạn xong ⇒ 409 LAYOUT_NOT_READY, không ghi mốc xác nhận", async () => {
    await expect(confirmLayout("p1")).rejects.toMatchObject({ code: "LAYOUT_NOT_READY" })
    expect(h.update).not.toHaveBeenCalled()
  })
  it("soạn xong ⇒ xác nhận lưu mốc và dấu bố cục", async () => {
    h.spine = { ...createEmptySpine({ name: "X" }), steps: [{ id: "S-4.1", status: "accepted" }] }
    await confirmLayout("p1")
    expect(h.update).toHaveBeenCalledOnce()
  })
  it("ký baseline khi chưa xác nhận bố cục ⇒ 409 LAYOUT_NOT_CONFIRMED", async () => {
    await expect(assertLayoutConfirmedForBaseline("p1")).rejects.toMatchObject({ code: "LAYOUT_NOT_CONFIRMED" })
  })
  it("đã xác nhận ⇒ cho ký; bố cục đổi sau xác nhận ⇒ chặn lại", async () => {
    h.spine = { ...createEmptySpine({ name: "X" }), steps: [{ id: "S-4.1", status: "accepted" }] }
    const { layoutSignatureOf } = await import("../render/source-fidelity.js")
    h.profile = { ...base(), layout_confirmed_at: new Date(), layout_confirmed_signature: layoutSignatureOf(h.spine as never) }
    await expect(assertLayoutConfirmedForBaseline("p1")).resolves.toBeUndefined()
    h.spine = { ...(h.spine as object), custom_sections: [{ id: "c9", heading: "Mới", level: 2, body: "" }] }
    await expect(assertLayoutConfirmedForBaseline("p1")).rejects.toMatchObject({ code: "LAYOUT_NOT_CONFIRMED" })
  })
})
