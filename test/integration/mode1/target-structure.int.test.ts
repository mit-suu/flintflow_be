/**
 * FLF-336 I-5 (lát 1) trên Mongo thật: dự án có ý định (`Project.template_intent`, FLF-335) mà file thiếu mục của cấu trúc
 * đích ⇒ finalize dừng ở `incomplete` (không có v0), `GET /import` / gap report mang `target_structure`; "Hoàn thiện"
 * (`complete: true`) ⇒ chạy lại từ mốc và tạo v0 như cũ. Dự án không có ý định ⇒ luồng cũ, chỉ lưu `target_structure`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())
import mongoose from "mongoose"
import { mockOverrides, resetMockLlm } from "../../helpers/mock-llm.js"
import { fakeMode1 } from "../../helpers/mode1.js"
import { importAtBaselining } from "../../helpers/mode1-import-p4.js"
import { startFinalize, waitForFinalize } from "../../../src/modules/import/finalize-jobs.js"
import { getImportView } from "../../../src/modules/import/import.service.js"
import { buildGapReport } from "../../../src/modules/import/gap-report.service.js"
import { ImportedDocument } from "../../../src/modules/import/imported-document.model.js"
import { DocVersion } from "../../../src/modules/doc-version/doc-version.model.js"
import * as spineRepository from "../../../src/modules/spine/spine.repository.js"

beforeEach(() => {
  resetMockLlm()
  mockOverrides.next = fakeMode1
})

const version = async (projectId: string) => (await spineRepository.get(projectId))!.spine_version
const finalize = async (projectId: string, userId: string, importId: string, body: { complete?: boolean } = {}) => {
  await startFinalize(projectId, userId, { import_id: importId, base_version: await version(projectId), ...body })
  await waitForFinalize(importId)
  return (await ImportedDocument.findById(importId))!
}

describe("FLF-336 I-5 — so cấu trúc đích trước v0", () => {
  it("ý định tự do + file thiếu mục ⇒ dừng incomplete (chế độ 4, không v0); gap report + GET /import có bản đồ mục; finalize thiếu complete ⇒ 409; Hoàn thiện ⇒ v0 + gap_review", async () => {
    const { projectId, userId, importId } = await importAtBaselining()
    // Dự án tạo qua picker FLF-335 (field chưa có trong model ở nhánh này ⇒ ghi thẳng collection)
    await mongoose.connection.db!.collection("projects").updateOne({ _id: new mongoose.Types.ObjectId(projectId) }, { $set: { template_intent: "free", start_kind: "existing" } })

    const stopped = await finalize(projectId, userId, importId)
    expect(stopped.status).toBe("incomplete")
    expect(stopped.paused).toBeNull()
    expect(await DocVersion.countDocuments({ projectId })).toBe(0)

    const view = await getImportView(projectId)
    expect(view.target_structure).toMatchObject({ target: "fpt", intent: "free", resolved_mode: 4 })
    expect(view.target_structure!.missing.length).toBeGreaterThan(0)
    expect(view.target_structure!.sections.some((s) => s.status === "present")).toBe(true)
    for (const s of view.target_structure!.sections.filter((x) => x.status === "missing")) expect(s.owner_steps.length).toBeGreaterThan(0)

    const report = await buildGapReport(projectId)
    expect(report.target_structure?.resolved_mode).toBe(4)

    await expect(startFinalize(projectId, userId, { import_id: importId, base_version: await version(projectId) })).rejects.toMatchObject({ code: "IMPORT_INVALID_STATE" })

    const done = await finalize(projectId, userId, importId, { complete: true })
    expect(done.status).toBe("gap_review")
    expect(done.complete_requested).toBe(true)
    const versions = await DocVersion.find({ projectId }).lean()
    expect(versions.map((v) => v.version)).toEqual(["0.1"])
    expect((await getImportView(projectId)).target_structure?.resolved_mode).toBe(4)
  })

  it("dự án không có ý định (cũ) ⇒ luồng cũ: v0 ngay, vẫn lưu target_structure để tham khảo", async () => {
    const { projectId, userId, importId } = await importAtBaselining()
    const done = await finalize(projectId, userId, importId)
    expect(done.status).toBe("gap_review")
    expect(await DocVersion.countDocuments({ projectId })).toBe(1)
    const view = await getImportView(projectId)
    expect(view.target_structure?.intent).toBe("free")
  })
})
