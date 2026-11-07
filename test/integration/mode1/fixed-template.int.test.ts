/**
 * FLF-278 trên FLF-335/336 — chế độ 3 (dự án mới có mẫu bắt buộc, `template_intent = fixed`), Mongo thật:
 *  - I-5: heading mẫu không map vào mục FlintFlow mà có chữ thật ⇒ `present`; chỉ có chữ hướng dẫn `[…]` ⇒ `missing`.
 *  - Bản in (business-flow 2.10): chỉ các mục của mẫu, không chèn mục FlintFlow ngoài mẫu.
 *  - Cờ vàng: mục FlintFlow có dữ liệu mà mẫu không có (`template_section_absent`), mục riêng của mẫu còn trống
 *    (`template_section_empty`).
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())
import mongoose from "mongoose"
import { mockOverrides, resetMockLlm } from "../../helpers/mock-llm.js"
import { fakeMode1 } from "../../helpers/mode1.js"
import { importAtBaselining } from "../../helpers/mode1-import-p4.js"
import { p, styled } from "../../../src/modules/docx-ooxml/testing/make-docx.js"
import { startFinalize, waitForFinalize } from "../../../src/modules/import/finalize-jobs.js"
import { readFile } from "node:fs/promises"
import { seedFixture } from "../../setup.js"
import { createMode1Project } from "../../helpers/mode1.js"
import { fileOf } from "../../helpers/mode1-import-p4.js"
import { runExtraction } from "../../../src/modules/import/extract.service.js"
import { acceptLatest, getImportView, uploadImport } from "../../../src/modules/import/import.service.js"
import { Project } from "../../../src/modules/project/project.model.js"
import { ImportedDocument } from "../../../src/modules/import/imported-document.model.js"
import { TemplateProfile } from "../../../src/modules/import/template-profile.model.js"
import { getDocument } from "../../../src/modules/render/assemble.service.js"
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

describe("chế độ 3 — mẫu bắt buộc", () => {
  // Dự án có sẵn theo mẫu cố định: "Hoàn thiện" khoá bản gốc (FLF-336). Dự án mới: chỉ Luồng 2 (`flow2.int.test.ts`).
  it("I-5 tính đúng mục riêng có chữ / chỉ chữ hướng dẫn; bản in không thêm mục ngoài mẫu; cờ vàng mục thiếu / trống", async () => {
    const { projectId, userId, importId } = await importAtBaselining({
      srs: { extraBody: styled("u2", "5.10 Document Conventions") + p("[Describe the typographical conventions used in this SRS.]") }
    })
    await mongoose.connection.db!
      .collection("projects")
      .updateOne({ _id: new mongoose.Types.ObjectId(projectId) }, { $set: { template_intent: "fixed", start_kind: "existing", has_required_template: true } })

    const stopped = await finalize(projectId, userId, importId)
    expect(stopped.status).toBe("incomplete")
    const structure = (await getImportView(projectId)).target_structure!
    expect(structure).toMatchObject({ target: "template", intent: "fixed", resolved_mode: 3 })
    const byTitle = (title: string) => structure.sections.find((s) => s.title.includes(title))
    // Lỗi (a) cũ: mục riêng có chữ thật luôn bị coi là thiếu
    expect(byTitle("Team Notes")?.status).toBe("present")
    // Lỗi (b) cũ: chữ hướng dẫn `[…]` bị tính là nội dung
    expect(byTitle("Document Conventions")?.status).toBe("missing")

    const done = await finalize(projectId, userId, importId, { complete: true })
    expect(done.status).toBe("gap_review")

    const profile = (await TemplateProfile.findOne({ projectId }).lean())!
    const layoutIds = new Set((profile.layout ?? []).map((l) => l.section_id))
    const doc = await getDocument(projectId, "Lumen", { source: "draft" })
    const printedFixed = doc.sections.map((s) => s.id).filter((id) => id.startsWith("fixed:") && id !== "fixed:I")
    expect(printedFixed.length).toBeGreaterThan(0)
    expect(printedFixed.filter((id) => !layoutIds.has(id))).toEqual([])

    const spine = (await spineRepository.get(projectId))!
    const open = spine.flags.filter((f) => !f.resolved_at)
    const empty = open.filter((f) => f.rule_id === "template_section_empty")
    expect(empty).toHaveLength(1)
    expect(empty[0]).toMatchObject({ level: "yellow" })
    expect(spine.custom_sections.find((c) => `custom:${c.id}` === empty[0].section_id)?.heading).toContain("Document Conventions")
    const absent = open.filter((f) => f.rule_id === "template_section_absent")
    expect(absent.length).toBeGreaterThan(0)
    expect(absent.every((f) => f.level === "yellow" && !layoutIds.has(f.section_id))).toBe(true)
  })

  it("dự án tự do (không phải mẫu bắt buộc): vẫn chèn mục FlintFlow thiếu, không có cờ mẫu", async () => {
    const { projectId, userId, importId } = await importAtBaselining()
    await finalize(projectId, userId, importId)
    const spine = (await spineRepository.get(projectId))!
    expect(spine.flags.some((f) => f.rule_id.startsWith("template_section_"))).toBe(false)
    const profile = (await TemplateProfile.findOne({ projectId }).lean())!
    const layoutIds = new Set((profile.layout ?? []).map((l) => l.section_id))
    const doc = await getDocument(projectId, "Lumen", { source: "draft" })
    expect(doc.sections.some((s) => s.id.startsWith("fixed:") && s.id !== "fixed:I" && !layoutIds.has(s.id))).toBe(true)
  })
})

describe("mẫu FU-IT-SRS-01 (dự án mới, mẫu bắt buộc) — bảng mẫu trống", () => {
  it("bảng chỉ có tiêu đề + hàng chỗ trống (3.2 / 5.1 / 5.2) ⇒ 'Sẽ soạn', không trích hàng chỗ trống thành dữ liệu", async () => {
    const seeded = await seedFixture("minimal", { balance: 1000 })
    const projectId = await createMode1Project(seeded)
    await Project.updateOne({ _id: projectId }, { $set: { template_intent: "fixed", start_kind: "new" } })
    const buffer = await readFile(new URL("../../../fixtures/fixed-template-fu-it-srs-01.docx", import.meta.url))
    const doc = await uploadImport(projectId, seeded.userId, fileOf(buffer, "Mau_SRS_FU-IT-SRS-01.docx"))
    await acceptLatest(doc, true)
    const importId = String(doc._id)
    await runExtraction(projectId, seeded.userId, importId)
    const stopped = await finalize(projectId, seeded.userId, importId)
    expect(stopped.status).toBe("incomplete")

    const structure = (await getImportView(projectId)).target_structure!
    const statusOf = (title: string) => structure.sections.find((s) => s.title.includes(title))?.status
    expect(statusOf("Functional Requirements")).toBe("missing")
    expect(statusOf("Business Rules")).toBe("missing")
    expect(statusOf("Messages")).toBe("missing")
    expect(structure.sections.filter((s) => s.status === "present").map((s) => s.title)).not.toContain("3.2 Functional Requirements")

    const spine = (await spineRepository.get(projectId))!
    const placeholder = /^\[.*\]$/
    for (const [kind, items] of [["functions", spine.functions], ["business_rules", spine.business_rules], ["messages", spine.messages]] as const) {
      const ids = (items as readonly { id: string }[]).map((i) => i.id)
      expect(ids.filter((id) => placeholder.test(id)), kind).toEqual([])
    }
  })
})
