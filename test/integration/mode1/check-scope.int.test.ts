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
import { estimateCheckCalls } from "../../../src/modules/import/check.service.js"
import { DocBlock } from "../../../src/modules/import/doc-block.model.js"
import { TemplateProfile } from "../../../src/modules/import/template-profile.model.js"
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

    // Mọi section có chữ Ngoài phạm vi ⇒ không còn lô nào, credit giảm đúng phần lô
    await DocBlock.updateMany({ projectId, section_id: null }, { $set: { section_id: "custom:CS99" } })
    const sectionIds = (await DocBlock.distinct("section_id", { projectId })).filter((s): s is string => !!s)
    await TemplateProfile.updateOne(
      { projectId },
      { $set: { "structure_preview.sections": sectionIds.map((section_id, order) => ({ section_id, title: section_id, status: "out_of_scope", order })) } }
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
    expect(semanticCalls).toBe(0)
    expect(await Usage.countDocuments({ projectId, step_id: /^I-1\.11/ })).toBe(0)
  })
})
