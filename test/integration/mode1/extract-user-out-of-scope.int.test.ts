/**
 * FLF-460 (BF §3.1.2 "số credit tính theo nhãn đã sửa"): mục người dùng gắn Ngoài phạm vi ở màn đọc khung không được đọc ở I-4
 * và không tính credit ở số ước tính.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import { mockOverrides, resetMockLlm } from "../../helpers/mock-llm.js"
import { fakeMode1 } from "../../helpers/mode1.js"
import { importAtExtracting, useExtractConcurrency } from "../../helpers/mode1-import-p4.js"
import { estimateExtraction, loadExtractionInputs, runExtraction } from "../../../src/modules/import/extract.service.js"
import { ExtractionDraft } from "../../../src/modules/import/extraction-draft.model.js"
import { TemplateProfile } from "../../../src/modules/import/template-profile.model.js"
import { ImportedDocument } from "../../../src/modules/import/imported-document.model.js"

useExtractConcurrency(1)

let sections: string[] = []
beforeEach(() => {
  resetMockLlm()
  sections = []
  mockOverrides.next = (prompt) => {
    if (prompt.includes("# Import Extract")) sections.push(/Section \(registry id\): (\S+)/.exec(prompt)?.[1] ?? "?")
    return fakeMode1(prompt)
  }
})

describe("I-4 bỏ qua mục nhãn tay Ngoài phạm vi", () => {
  it("ước tính giảm và lúc chạy không gọi AI cho mục đó", async () => {
    const ctx = await importAtExtracting()
    const doc = (await ImportedDocument.findById(ctx.importId))!
    const before = (await estimateExtraction(ctx.projectId, doc))!
    expect(before.text_batches).toBeGreaterThan(0)

    // Gắn nhãn cho mục đọc đầu tiên có lượt chữ
    const inputs = (await loadExtractionInputs(ctx.projectId))!
    const profile = (await TemplateProfile.findOne({ projectId: ctx.projectId }))!
    const target = inputs.plan.find((id) => profile.heading_map.some((h) => (h.section_id === "unmapped" ? `content:@${h.block_id}` : h.section_id) === id))!
    expect(target).toBeTruthy()
    const entry = profile.heading_map.find((h) => (h.section_id === "unmapped" ? `content:@${h.block_id}` : h.section_id) === target)!
    entry.scope_label = "out_of_scope"
    profile.markModified("heading_map")
    await profile.save()

    const after = (await estimateExtraction(ctx.projectId, doc))!
    expect(after.ai_calls).toBeLessThan(before.ai_calls)
    await runExtraction(ctx.projectId, ctx.userId, ctx.importId)
    expect(sections).not.toContain(target)
    expect((await ExtractionDraft.findOne({ import_id: ctx.importId, section_id: target }).lean())?.status).toBe("done")
    // Mục khác vẫn được đọc
    expect(sections.length).toBeGreaterThan(0)
  })
})
