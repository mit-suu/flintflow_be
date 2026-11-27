/**
 * FLF-462 (ý Jira): (a) độ tin thấp ở I-3 KHÔNG dừng (`autoConfirmMapping` — trước bước 1.6 chỉ I-4 mới dừng): mục tự nhận
 * (`auto_confirmed`) và thành cờ vàng "Cần xem"; (b) đoạn lớp 4 không thêm lượt gọi AI — AI phân loại ngay trong lượt I-4 sẵn có.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import { mockOverrides, resetMockLlm } from "../../helpers/mock-llm.js"
import { fakeMode1 } from "../../helpers/mode1.js"
import { importAtExtracting, runExtraction as runExtractionConfirmed, useExtractConcurrency } from "../../helpers/mode1-import-p4.js"
import { runExtraction } from "../../../src/modules/import/extract.service.js"
import { finalizeImport } from "../../../src/modules/import/finalize.service.js"
import { DocBlock } from "../../../src/modules/import/doc-block.model.js"
import { ImportedDocument } from "../../../src/modules/import/imported-document.model.js"
import { TemplateProfile } from "../../../src/modules/import/template-profile.model.js"
import { Usage } from "../../../src/modules/spine/usage.model.js"
import * as spineRepository from "../../../src/modules/spine/spine.repository.js"

useExtractConcurrency(1)

let extractPrompts: string[] = []
const sectionOf = (prompt: string) => /Section \(registry id\): (\S+)/.exec(prompt)?.[1] ?? "?"

beforeEach(() => {
  resetMockLlm()
  extractPrompts = []
  mockOverrides.next = (prompt) => {
    if (prompt.includes("# Import Extract")) extractPrompts.push(prompt)
    return fakeMode1(prompt)
  }
})

describe("FLF-462 - I-3 độ tin thấp không dừng", () => {
  it("heading không style (độ tin thấp) ⇒ không dừng ở bước xác nhận mapping, mục mang auto_confirmed, chạy I-4 + finalize xong có cờ Cần xem cho từng mục", async () => {
    const ctx = await importAtExtracting({ srs: { numberedOnly: true } })
    // Sau upload + parse: dừng ở extracting (màn báo credit), không phải mapping_review
    expect((await ImportedDocument.findById(ctx.importId))!.status).toBe("extracting")
    const profile = (await TemplateProfile.findOne({ projectId: ctx.projectId }).lean())!
    const low = profile.heading_map.filter((h) => h.confidence < 0.8)
    expect(low.length).toBeGreaterThan(0)
    expect(low.every((h) => h.confirmed && h.auto_confirmed)).toBe(true)

    // I-4 chạy thẳng, không có trạng thái mapping_review nào xen vào
    const run = await runExtractionConfirmed(ctx.projectId, ctx.userId, ctx.importId)
    expect(run.doc.status).toBe("baselining")
    const after = (await TemplateProfile.findOne({ projectId: ctx.projectId }).lean())!
    expect(after.heading_map.filter((h) => h.confidence < 0.8).every((h) => h.confirmed && h.auto_confirmed)).toBe(true)

    // Cờ vàng "Cần xem" cho mỗi mục tự nhận, target = block heading
    await finalizeImport(ctx.projectId, ctx.userId, { import_id: ctx.importId, base_version: (await spineRepository.get(ctx.projectId))!.spine_version })
    const flags = (await spineRepository.get(ctx.projectId))!.flags.filter((f) => f.rule_id === "import_needs_review" && f.resolved_at === null)
    for (const h of low) {
      const mine = flags.filter((f) => f.target_id === h.block_id)
      expect(mine, h.heading_text).toHaveLength(1)
      expect(mine[0].level).toBe("yellow")
      expect(mine[0].message.startsWith("Cần xem:")).toBe(true)
    }
  }, 120000)
})

describe("FLF-462 - lớp 4 không thêm lượt gọi AI", () => {
  const aiCalls = async (withLayer4: boolean): Promise<{ prompts: number; usages: number }> => {
    extractPrompts = []
    const ctx = await importAtExtracting()
    if (withLayer4) {
      const block = (await DocBlock.findOne({ projectId: ctx.projectId, section_id: "fixed:4.2.3", kind: "paragraph" }).lean())!
      expect(block, "cần một block ở fixed:4.2.3 để gắn lớp 4").toBeTruthy()
      await DocBlock.updateOne({ _id: block._id }, { $set: { guidance_layer: 4 } })
      mockOverrides.next = (prompt) => {
        if (prompt.includes("# Import Extract")) extractPrompts.push(prompt)
        const out = fakeMode1(prompt)
        if (!out || sectionOf(prompt) !== "fixed:4.2.3") return out
        return JSON.stringify({ ...JSON.parse(out), guidance_blocks: [{ block_id: block.block_id, is_guidance: true, confidence: 0.4 }] })
      }
    }
    await runExtraction(ctx.projectId, ctx.userId, ctx.importId)
    return { prompts: extractPrompts.length, usages: await Usage.countDocuments({ projectId: ctx.projectId, call_kind: /import_extract/ }) }
  }

  it("cùng file: số lượt I-4 (prompt gọi AI và Usage) khi có đoạn lớp 4 bằng đúng khi không có", async () => {
    const plain = await aiCalls(false)
    expect(plain.prompts).toBeGreaterThan(0)
    expect(plain.usages).toBeGreaterThan(0)
    const layer4 = await aiCalls(true)
    expect(layer4).toEqual(plain)
  }, 180000)
})
