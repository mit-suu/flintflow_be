/**
 * FLF-343 — bản ghi import cũ (trước luồng một mạch) đi tiếp được tới trang tạo CR: `awaiting_latest_confirm` / `mapping_review`
 * + Bắt đầu (`/import/extract`), `fields_review` + Tiếp tục (`/import/resume`); và lỗi bật finalize nối tiếp không làm I-4 chạy lại.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import { mockOverrides, resetMockLlm } from "../../helpers/mock-llm.js"
import { createMode1Project, fakeMode1, mode1Api } from "../../helpers/mode1.js"
import { seedFixture } from "../../setup.js"
import { makeSrsDocx } from "../../../src/modules/import/testing/srs-fixture.js"
import { getImportResponseSchema } from "../../../src/modules/import/import.dto.js"
import { ImportedDocument } from "../../../src/modules/import/imported-document.model.js"
import { TemplateProfile } from "../../../src/modules/import/template-profile.model.js"
import { runExtraction } from "../../../src/modules/import/extract.service.js"
import { chainFinalize } from "../../../src/modules/import/extract-jobs.js"
import * as spineRepository from "../../../src/modules/spine/spine.repository.js"

beforeEach(() => {
  resetMockLlm()
  mockOverrides.next = fakeMode1
})

const uploaded = async (numberedOnly = false) => {
  const seeded = await seedFixture("minimal")
  const projectId = await createMode1Project(seeded)
  const c = mode1Api(seeded, projectId)
  const id = (await c.upload(await makeSrsDocx({ numberedOnly }))).body.data.import.id as string
  return { seeded, projectId, c, id }
}

describe("FLF-343 — bản ghi cũ", () => {
  it("awaiting_latest_confirm: Bắt đầu không xác nhận ⇒ 409, không tách file; có confirm_latest ⇒ tách file rồi chạy một mạch tới gap_review", async () => {
    const { c, id, projectId } = await uploaded()
    await ImportedDocument.updateOne({ _id: id }, { $set: { status: "awaiting_latest_confirm", confirmed_latest_at: null } })
    await TemplateProfile.deleteMany({ projectId })

    const refused = await c.post("/import/extract", { import_id: id })
    expect(refused.status).toBe(409)
    expect(refused.body.error.code).toBe("IMPORT_NEEDS_LATEST_CONFIRM")
    expect(await TemplateProfile.countDocuments({ projectId })).toBe(0)
    expect((await ImportedDocument.findById(id).lean())?.status).toBe("awaiting_latest_confirm")

    const run = await c.extractAndWait(id)
    expect(run.res.status, JSON.stringify(run.res.body.error)).toBe(200)
    expect(run.run?.import.status).toBe("gap_review")
    expect((await ImportedDocument.findById(id).lean())?.confirmed_latest_at).not.toBeNull()
  })

  it("mapping_review: Bắt đầu ⇒ mục độ tin thấp confirmed + auto_confirmed (giữ độ tin), chạy tới gap_review", async () => {
    const { c, id, projectId } = await uploaded(true)
    const profile = (await TemplateProfile.findOne({ projectId }))!
    for (const h of profile.heading_map) if (h.auto_confirmed) Object.assign(h, { confirmed: false, auto_confirmed: undefined })
    profile.markModified("heading_map")
    await profile.save()
    await ImportedDocument.updateOne({ _id: id }, { $set: { status: "mapping_review" } })
    const low = profile.heading_map.filter((h) => h.confidence < 0.8).map((h) => h.block_id)
    expect(low.length).toBeGreaterThan(0)

    const run = await c.extractAndWait(id)
    expect(run.run?.import.status).toBe("gap_review")
    const after = getImportResponseSchema.parse((await c.get("/import")).body.data).profile!
    for (const h of after.heading_map.filter((x) => low.includes(x.block_id))) expect(h).toMatchObject({ confirmed: true, auto_confirmed: true })
  })

  it("fields_review: Tiếp tục ⇒ baseline 0.1 + cờ Cần xem, tới gap_review", async () => {
    const { c, id, projectId, seeded } = await uploaded()
    await runExtraction(projectId, seeded.userId, id)
    await ImportedDocument.updateOne({ _id: id }, { $set: { status: "fields_review", paused: null } })

    const resumed = await c.finalizeAndWait(id, {}, "/import/resume")
    expect(resumed.res.status, JSON.stringify(resumed.res.body.error)).toBe(200)
    expect(resumed.view?.import).toMatchObject({ status: "gap_review", paused: null })
    const spine = (await spineRepository.get(projectId))!
    expect(spine.baselines.find((b) => b.type === "imported")).toMatchObject({ version: "0.1" })
    expect(spine.flags.filter((f) => f.rule_id === "import_needs_review" && f.resolved_at === null).length).toBeGreaterThan(0)
  })

  it("bật finalize nối tiếp lỗi ⇒ không ném ra job I-4, import baselining + paused resume_later", async () => {
    const { c, id, projectId, seeded } = await uploaded()
    await runExtraction(projectId, seeded.userId, id)
    // upload khác thay lần import này ⇒ startAutoFinalize ném (lần import đã bị thay)
    await c.upload(await makeSrsDocx())
    await expect(chainFinalize(projectId, seeded.userId, id)).resolves.toBeUndefined()
    expect(await ImportedDocument.findById(id).lean()).toMatchObject({ status: "baselining", paused: { reason: "resume_later" } })
  })
})
