/**
 * FLF-454 (business-flow §2 "Ai kiểm", "Báo trước khi chạy hàng loạt"), Mongo thật + AI giả:
 *  - số credit bước 1.9 báo ở màn đọc khung: có phần 1.9 khi file đủ cấu trúc đích, không có khi thiếu, giảm khi loại section;
 *  - file thiếu cấu trúc đích thì bước 1.9 không gọi AI, không trừ credit.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import mongoose from "mongoose"
import { mockOverrides, resetMockLlm } from "../../helpers/mock-llm.js"
import { fakeMode1 } from "../../helpers/mode1.js"
import { importAtBaselining } from "../../helpers/mode1-import-p4.js"
import { p, styled } from "../../../src/modules/docx-ooxml/testing/make-docx.js"
import { startFinalize, waitForFinalize } from "../../../src/modules/import/finalize-jobs.js"
import { estimateCheckCalls, runImportCheck } from "../../../src/modules/import/check.service.js"
import { DocBlock } from "../../../src/modules/import/doc-block.model.js"
import { TemplateProfile } from "../../../src/modules/import/template-profile.model.js"
import { ImportedDocument } from "../../../src/modules/import/imported-document.model.js"
import { Usage } from "../../../src/modules/spine/usage.model.js"
import * as spineRepository from "../../../src/modules/spine/spine.repository.js"

let semanticCalls = 0
beforeEach(() => {
  resetMockLlm()
  semanticCalls = 0
  mockOverrides.next = (prompt: string) => {
    if (prompt.includes("# Import Semantic Check") || prompt.includes("# Import Cross-Section Check")) semanticCalls++
    return fakeMode1(prompt)
  }
})

const setIntent = (projectId: string, template_intent: "fixed" | "free") =>
  mongoose.connection.db!.collection("projects").updateOne({ _id: new mongoose.Types.ObjectId(projectId) }, { $set: { template_intent, start_kind: "existing" } })

describe("credit bước 1.9 báo ở màn đọc khung", () => {
  it("đủ cấu trúc đích ⇒ có phần 1.9; thiếu ⇒ không có; loại section ⇒ số lô / credit giảm", async () => {
    const { projectId } = await importAtBaselining()
    await setIntent(projectId, "free")
    // Bản so sơ bộ: file đủ cấu trúc đích (chế độ 1)
    await TemplateProfile.updateOne({ projectId }, { $set: { "structure_preview.resolved_mode": 1 } })
    expect((await TemplateProfile.findOne({ projectId }).lean())!.structure_preview).toBeTruthy()

    const full = await estimateCheckCalls(projectId)
    expect(full.batches).toBeGreaterThan(0)
    expect(full.calls).toBe(full.batches + 1)
    expect(full.credits).toBeGreaterThan(0)

    // Mọi section Ngoài phạm vi ⇒ không còn lô nào, credit giảm đúng phần lô. Giữ nguyên `DocBlock.section_id` thật (khối chữ dưới
    // heading riêng là null): bản sơ bộ gắn mục vào heading qua `block_id`
    const preview = (await TemplateProfile.findOne({ projectId }).lean())!.structure_preview!
    expect(preview.sections.some((s) => s.block_id)).toBe(true)
    await TemplateProfile.updateOne(
      { projectId },
      { $set: { "structure_preview.sections": preview.sections.map((s) => ({ ...s, status: "out_of_scope" })) } }
    )
    const scoped = await estimateCheckCalls(projectId)
    expect(scoped.batches).toBe(0)
    expect(scoped.credits).toBeLessThan(full.credits)

    // File thiếu cấu trúc đích (I-5 sơ bộ ra chế độ 4) ⇒ không có phần 1.9
    await TemplateProfile.updateOne({ projectId }, { $set: { "structure_preview.resolved_mode": 4 } })
    expect(await estimateCheckCalls(projectId)).toEqual({ batches: 0, calls: 0, credits: 0 })
  })
})

describe("file thiếu cấu trúc đích: bước 1.9 không chạy", () => {
  it("giữ khung còn mục trống + yêu cầu hoàn thiện ⇒ không gọi AI 1.9, không trừ credit", async () => {
    const { projectId, userId, importId } = await importAtBaselining({
      srs: { extraBody: styled("u2", "5.10 Document Conventions") + p("[Describe the typographical conventions used in this SRS.]") }
    })
    await setIntent(projectId, "fixed")
    await mongoose.connection.db!.collection("projects").updateOne({ _id: new mongoose.Types.ObjectId(projectId) }, { $set: { has_required_template: true } })

    await startFinalize(projectId, userId, { import_id: importId, base_version: (await spineRepository.get(projectId))!.spine_version, complete: true })
    await waitForFinalize(importId)

    const profile = (await TemplateProfile.findOne({ projectId }).lean())!
    expect(profile.target_structure!.resolved_mode).not.toBe(1)
    // FLF-454: finalize gắn mỗi mục với heading đầu của nó để bước 1.9 nối khối chữ với mục
    expect(profile.target_structure!.sections.some((s) => s.block_id)).toBe(true)
    expect(semanticCalls).toBe(0)
    expect(await Usage.countDocuments({ projectId, step_id: /^I-1\.11/ })).toBe(0)
  })
})

describe("FLF-454: khối chữ dưới heading riêng bị loại theo dữ liệu thật qua finalize", () => {
  it("mục Ngoài phạm vi (chữ chi phí, section_id của khối là null) và mục lục không vào lượt AI; mục thường vẫn vào", async () => {
    const { projectId, userId, importId } = await importAtBaselining({
      srs: { extraBody: styled("u2", "5.10 Document Conventions") + p("[Describe the conventions.]") }
    })
    await setIntent(projectId, "free")
    // Mục riêng "Kế hoạch tài chính" ngoài phạm vi theo nhãn người dùng; mục lục tự sinh
    const COST_TEXT = "Chi phí phát triển dự kiến 500 triệu đồng COSTMARK"
    const last = (await DocBlock.findOne({ projectId }).sort({ "anchor.ordinal": -1 }).lean())!
    const mk = (i: number, kind: string, text: string, extra: Record<string, unknown> = {}) => ({
      projectId: last.projectId,
      doc_version: last.doc_version,
      block_id: `B${8000 + i}`,
      kind,
      anchor: { xml_path: `/x/${i}`, ordinal: last.anchor.ordinal + 1 + i },
      text,
      text_hash: `x-${i}`,
      ...extra
    })
    await DocBlock.insertMany([
      mk(0, "heading", "Mục lục", { level: 1, section_id: null }),
      mk(1, "paragraph", "TOCMARK 1 Giới thiệu ........ 3", { section_id: null }),
      mk(2, "heading", "Kế hoạch tài chính", { level: 1, section_id: null }),
      mk(3, "paragraph", COST_TEXT, { section_id: null })
    ])
    const profile = (await TemplateProfile.findOne({ projectId }).lean())!
    // Cấu trúc đích như finalize ghi: mục tài chính ngoài phạm vi, gắn heading đầu của mục
    const sections = [
      ...(profile.target_structure?.sections ?? profile.structure_preview?.sections ?? []).map((x) => ({ ...x, block_id: undefined })),
      { section_id: "custom:CS90", title: "Kế hoạch tài chính", status: "out_of_scope", owner_steps: [], block_id: "B8002" }
    ]
    await TemplateProfile.updateOne(
      { projectId },
      {
        $set: {
          target_structure: { target: "fpt", intent: "free", resolved_mode: 1, sections, missing: [], compared_at: new Date().toISOString() },
          heading_map: [...profile.heading_map, { block_id: "B8000", section_id: "unmapped", heading_text: "Mục lục" }]
        }
      }
    )
    const { loadCheckInput, semanticBatches } = await import("../../../src/modules/import/check.service.js")
    const { blocks, scope } = await loadCheckInput(projectId)
    const lines = semanticBatches(blocks, 48_000, scope).map((b) => b.lines).join("\n")
    expect(lines).not.toContain("COSTMARK")
    expect(lines).not.toContain("TOCMARK")
    // Chữ thường của file vẫn được kiểm
    expect(blocks.some((b) => b.section_id) && lines.length).toBeGreaterThan(0)
    void userId
    void importId
  })
})

describe("FLF-454: credit 1.9 lúc chạy lớn hơn số đã báo ở màn đọc khung", () => {
  it("bản sơ bộ chế độ 4 (báo 0 cho 1.9) nhưng cấu trúc đích cuối là chế độ 1 ⇒ dừng báo lại credit, chưa gọi AI; tiếp tục thì chạy", async () => {
    const { projectId, userId, importId } = await importAtBaselining()
    await setIntent(projectId, "free")
    await TemplateProfile.updateOne(
      { projectId },
      {
        $set: {
          "structure_preview.resolved_mode": 4,
          target_structure: { target: "fpt", intent: "free", resolved_mode: 1, sections: [], missing: [], compared_at: new Date().toISOString() }
        }
      }
    )
    await ImportedDocument.updateOne({ _id: importId }, { $set: { status: "checking" } })
    const doc = (await ImportedDocument.findById(importId))!
    expect(await runImportCheck(doc, userId)).toBe(false)
    expect(doc.paused?.reason).toBe("user")
    expect((await TemplateProfile.findOne({ projectId }).lean())!.check_credit_notice?.credits).toBeGreaterThan(0)
    expect(semanticCalls).toBe(0)

    // Bấm tiếp tục = xác nhận đúng số đã báo lại
    expect(await runImportCheck(doc, userId)).toBe(true)
    expect(semanticCalls).toBeGreaterThan(0)
    expect(doc.status).toBe("gap_review")
  })
})
