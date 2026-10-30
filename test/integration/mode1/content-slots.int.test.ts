/**
 * FLF-278 trên FLF-335/336 — phần nhỏ `slot:*` ở mapping review của import, Mongo thật: heading matcher chưa khớp mà tiêu
 * đề chỉ đúng một phần dữ liệu (Operating Environment) ⇒ gợi ý slot dưới ngưỡng ⇒ BA xác nhận ở 1.5; slot + mục FPT cha
 * cùng có heading ⇒ 409 (in hai lần); bản in có heading của mẫu cho phần nhỏ, không chèn lại mục cha.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())
import { mockOverrides, resetMockLlm } from "../../helpers/mock-llm.js"
import { createMode1Project, fakeMode1 } from "../../helpers/mode1.js"
import { fileOf } from "../../helpers/mode1-import-p4.js"
import { seedFixture } from "../../setup.js"
import { p, styled } from "../../../src/modules/docx-ooxml/testing/make-docx.js"
import { makeSrsDocx } from "../../../src/modules/import/testing/srs-fixture.js"
import { patchMapping, uploadImport } from "../../../src/modules/import/import.service.js"
import { ImportedDocument } from "../../../src/modules/import/imported-document.model.js"
import { runExtraction } from "../../../src/modules/import/extract.service.js"
import { finalizeImport } from "../../../src/modules/import/finalize.service.js"
import { TemplateProfile } from "../../../src/modules/import/template-profile.model.js"
import { getDocument } from "../../../src/modules/render/assemble.service.js"
import * as spineRepository from "../../../src/modules/spine/spine.repository.js"

beforeEach(() => {
  resetMockLlm()
  mockOverrides.next = fakeMode1
})

describe("slot:* ở mapping review import", () => {
  it("gợi ý phần nhỏ cho heading lạ ⇒ BA xác nhận; chồng lấn với mục cha ⇒ 409; bản in giữ heading mẫu cho phần nhỏ", async () => {
    const seeded = await seedFixture("minimal", { balance: 1000 })
    const projectId = await createMode1Project(seeded)
    const buffer = await makeSrsDocx({ extraBody: styled("u1", "6 Operating Environment") + p("The app runs on Android 10+ and iOS 15+.") })
    const doc = await uploadImport(projectId, seeded.userId, fileOf(buffer))
    // FLF-343: không dừng ở mapping_review — gợi ý phần nhỏ độ tin thấp được tự nhận (giữ độ tin, cờ Cần xem sau baseline)
    expect(doc.status).toBe("extracting")

    const profile = (await TemplateProfile.findOne({ projectId }))!
    const env = profile.heading_map.find((h) => h.heading_text.includes("Operating Environment"))!
    expect(env).toMatchObject({ section_id: "slot:platforms", confirmed: true, auto_confirmed: true })
    expect(env.confidence).toBeLessThan(0.8)
    // Bản ghi cũ còn ở mapping_review (trước FLF-343) vẫn sửa mapping được
    await ImportedDocument.updateOne({ _id: doc._id }, { $set: { status: "mapping_review" } })
    const overview = profile.heading_map.find((h) => h.section_id === "fixed:1")!

    // Phần nhỏ của chính mục đang có heading ⇒ nội dung in hai lần ⇒ từ chối, mapping giữ nguyên
    await expect(
      patchMapping(projectId, { import_id: String(doc._id), headings: [{ block_id: env.block_id, section_id: "slot:vision" }], tables: [], confirm_all: true })
    ).rejects.toMatchObject({ code: "IMPORT_INVALID_STATE" })
    expect((await TemplateProfile.findOne({ projectId }))!.heading_map.find((h) => h.block_id === env.block_id)!.section_id).toBe("slot:platforms")
    expect(overview.section_id).toBe("fixed:1")

    const confirmed = await patchMapping(projectId, { import_id: String(doc._id), headings: [], tables: [], confirm_all: true })
    expect(confirmed.status).toBe("extracting")
    const run = await runExtraction(projectId, seeded.userId, String(doc._id))
    expect(run.doc.status).toBe("baselining")
    const before = (await spineRepository.get(projectId))!
    await finalizeImport(projectId, seeded.userId, { import_id: String(doc._id), base_version: before.spine_version })

    const layout = (await TemplateProfile.findOne({ projectId }).lean())!.layout ?? []
    expect(layout.map((l) => l.section_id)).toContain("slot:platforms")
    const rendered = await getDocument(projectId, "Lumen", { source: "draft" })
    const slot = rendered.sections.find((s) => s.id === "slot:platforms")
    expect(slot?.heading).toBe("Operating Environment")
    expect(rendered.sections.filter((s) => s.id === "fixed:1")).toHaveLength(1)
  })
})
