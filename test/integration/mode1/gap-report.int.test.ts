/**
 * Gap report (nút 1.13, UC-23) trên Mongo thật + provider AI giả — plan §8.2 `gap-report.test.ts`. FLF-172 P4.
 * Gộp đúng nhóm (cờ theo section, section bắt buộc thiếu, heading unmapped, field độ tin thấp); xuất .docx mở
 * được (đọc lại bằng `docx-ooxml`); tải lần đầu ⇒ `delivered`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import { mockOverrides, resetMockLlm } from "../../helpers/mock-llm.js"
import { fakeMode1 } from "../../helpers/mode1.js"
import { importAtExtracting, importFinalized } from "../../helpers/mode1-import-p4.js"
import { buildGapReport, markDelivered, renderGapReportDocx } from "../../../src/modules/import/gap-report.service.js"
import { gapReportSchema } from "../../../src/modules/import/import.dto.js"
import { ExtractionDraft } from "../../../src/modules/import/extraction-draft.model.js"
import { ImportedDocument } from "../../../src/modules/import/imported-document.model.js"
import { TemplateProfile } from "../../../src/modules/import/template-profile.model.js"
import { DocxPackage, readBlocks } from "../../../src/modules/docx-ooxml/index.js"
import { applyTransaction } from "../../../src/modules/spine/op-engine.js"
import type { Flag } from "../../../src/modules/spine/spine.types.js"
import * as spineRepository from "../../../src/modules/spine/spine.repository.js"

beforeEach(() => {
  resetMockLlm()
  mockOverrides.next = fakeMode1
})

const flag = (id: string, level: "red" | "yellow", section_id: string, message: string, resolved_at: string | null = null): Flag => ({
  id,
  level,
  rule_id: level === "red" ? "dead_reference" : "orphan_actor",
  section_id,
  target_id: null,
  message,
  remediation_step: "C-1",
  opened_at_version: 1,
  resolved_at,
  waived_by_user: false,
  waive_reason: null,
  waived_at_version: null
})

/** Thêm cờ tay: đỏ + vàng ở 4.2.3 (đã có cờ AI vàng), vàng ở 5.1, một cờ đã đóng. */
const seedFlags = async (projectId: string) => {
  const s = (await spineRepository.get(projectId))!
  await applyTransaction(projectId, {
    base_version: s.spine_version,
    by: "import",
    reason: "test",
    step_id: null,
    ops: [
      { op: "add", path: "flags[]", value: flag("FL901", "yellow", "fixed:4.2.3", "yellow first in insertion order") },
      { op: "add", path: "flags[]", value: flag("FL902", "red", "fixed:4.2.3", "red must sort first") },
      { op: "add", path: "flags[]", value: flag("FL903", "yellow", "fixed:5.1", "BR note") },
      { op: "add", path: "flags[]", value: flag("FL904", "red", "fixed:1", "closed", "2026-09-01T00:00:00.000Z") }
    ]
  })
}

describe("gap report — gộp nhóm", () => {
  it("cờ mở gộp theo section (đỏ trước), cờ đã đóng bị bỏ, totals khớp từng nhóm", async () => {
    const { projectId } = await importFinalized()
    await seedFlags(projectId)
    const report = gapReportSchema.parse(await buildGapReport(projectId))
    const spine = (await spineRepository.get(projectId))!
    const open = spine.flags.filter((f) => f.resolved_at === null)

    // mỗi section một nhóm, tổng số cờ trong nhóm = số cờ mở
    expect(new Set(report.sections.map((s) => s.section_id)).size).toBe(report.sections.length)
    expect(report.sections.flatMap((s) => s.flags).map((f) => f.id).sort()).toEqual(open.map((f) => f.id).sort())
    expect(report.sections.flatMap((s) => s.flags).some((f) => f.id === "FL904")).toBe(false)
    for (const s of report.sections) for (const f of s.flags) expect(f.section_id).toBe(s.section_id)

    const perf = report.sections.find((s) => s.section_id === "fixed:4.2.3")!
    expect(perf.title).toBe("4.2.3 Performance")
    expect(perf.flags[0]).toMatchObject({ id: "FL902", level: "red" })
    expect(perf.flags.slice(1).every((f) => f.level === "yellow")).toBe(true)
    expect(perf.flags.map((f) => f.rule_id)).toContain("import_semantic")

    expect(report.totals).toEqual({
      red: open.filter((f) => f.level === "red").length,
      yellow: open.filter((f) => f.level === "yellow").length,
      missing_sections: report.missing_sections.length,
      unmapped_headings: report.unmapped_headings.length,
      low_confidence_fields: report.low_confidence_fields.length,
      missing_fpt_sections: report.missing_fpt_sections.length,
      unrendered_diagrams: report.unrendered_diagrams.length
    })
    // FL902 (test đặt) + section_empty của đầu mục FPT file không có (D6, FLF-183)
    expect(report.totals.red).toBe(1 + open.filter((f) => f.level === "red" && f.rule_id === "section_empty").length)
    expect(report.doc_version).toBe("0.0")
  })

  it("FLF-184: thiếu mục FPT theo kế hoạch step (D6); cờ + mục xếp theo layout file upload; mục riêng loại custom, phần nối không liệt kê", async () => {
    const { projectId } = await importFinalized()
    await seedFlags(projectId)
    const report = gapReportSchema.parse(await buildGapReport(projectId))
    const profile = (await TemplateProfile.findOne({ projectId }).lean())!
    // Mỗi section FPT thiếu một dòng, step đầu tiên sở hữu nó; Screens Flow + Business Rules… file không có
    const missing = new Map(report.missing_fpt_sections.map((m) => [m.section_id, m]))
    expect(missing.get("fixed:3.1.1")).toMatchObject({ title: "Screens Flow", step_id: "S-4.2", in_layout: false })
    expect(missing.has("fixed:2.1")).toBe(false)
    expect(new Set(report.missing_fpt_sections.map((m) => m.section_id)).size).toBe(report.missing_fpt_sections.length)
    const planMissing = new Set(profile.step_plan.filter((p) => p.missing && p.state !== "hidden").flatMap((p) => p.section_ids))
    expect(new Set(missing.keys())).toEqual(planMissing)
    // Layout: đúng thứ tự file, bỏ phần nối (tiêu đề rỗng)
    expect(report.layout.map((l) => l.heading)).toEqual(profile.layout.filter((l) => l.heading_text).map((l) => l.heading_text))
    expect(report.layout.find((l) => l.heading === "5.9 Team Notes")?.kind).toBe("custom")
    expect(report.layout.find((l) => l.heading === "2 User Requirements")?.kind).toBe("group")
    expect(report.layout.find((l) => l.section_id === "fixed:4.2.3")).toMatchObject({ kind: "fpt", red: 1 })
    // Cờ theo section: section trong layout theo thứ tự file, section ngoài layout sau cùng
    const order = new Map(report.layout.map((l) => [l.section_id, l.order]))
    const ranks = report.sections.map((s) => order.get(s.section_id) ?? Infinity)
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
  })

  it("nợ T4: import khi không có PlantUML ⇒ báo cáo liệt kê hình chưa vẽ (loại có dữ liệu), không chặn baseline", async () => {
    const { projectId } = await importFinalized()
    const report = gapReportSchema.parse(await buildGapReport(projectId))
    const spine = (await spineRepository.get(projectId))!
    expect(spine.diagrams).toEqual([]) // môi trường test không có PlantUML ⇒ finalize bỏ qua bước vẽ
    expect(report.totals.unrendered_diagrams).toBe(report.unrendered_diagrams.length)
    expect(report.unrendered_diagrams.length).toBeGreaterThan(0)
    for (const d of report.unrendered_diagrams) expect(d).toMatchObject({ diagram_id: "", reason: "not_rendered" })
    // chỉ là thông tin: không đẻ cờ đỏ nào về hình
    expect(spine.flags.some((f) => f.rule_id === "render_error" && f.resolved_at === null)).toBe(false)
  })

  it("section bắt buộc thiếu = required_sections của profile; heading unmapped giữ nguyên văn", async () => {
    const { projectId } = await importFinalized()
    const report = await buildGapReport(projectId)
    const profile = (await TemplateProfile.findOne({ projectId }).lean())!
    expect(report.missing_sections.map((m) => m.section_id)).toEqual(profile.required_sections)
    expect(report.missing_sections.find((m) => m.section_id === "fixed:3.1.1")?.title).toBe("Screens Flow")
    expect(report.missing_sections.map((m) => m.section_id)).not.toContain("fixed:2.1")
    const notes = profile.heading_map.find((h) => h.heading_text === "5.9 Team Notes")!
    expect(report.unmapped_headings).toEqual([{ block_id: notes.block_id, text: "5.9 Team Notes" }])
  })

  it("field độ tin thấp: gồm cả field đã xác nhận (kèm confirmed/edited_value), không gồm field độ tin cao", async () => {
    const { projectId, importId } = await importFinalized()
    const report = await buildGapReport(projectId)
    expect(report.low_confidence_fields.map((f) => f.path).sort()).toEqual(["functions[id=FR-3.2.1].trigger", "functions[id=FR-3.2.2].trigger"])
    expect(report.low_confidence_fields.every((f) => f.confidence < 0.7 && f.confirmed)).toBe(true)
    const all = (await ExtractionDraft.find({ import_id: importId }).lean()).flatMap((d) => d.fields)
    expect(all.filter((f) => f.confidence < 0.7)).toHaveLength(report.low_confidence_fields.length)
  })

  it("trước bước check ⇒ IMPORT_INVALID_STATE", async () => {
    const { projectId } = await importAtExtracting()
    await expect(buildGapReport(projectId)).rejects.toMatchObject({ code: "IMPORT_INVALID_STATE" })
  })
})

describe("gap report — .docx", () => {
  it("xuất .docx mở được bằng docx-ooxml, nội dung khớp báo cáo JSON", async () => {
    const { projectId } = await importFinalized()
    await seedFlags(projectId)
    const report = await buildGapReport(projectId)
    const buf = await renderGapReportDocx(report, "Lumen import")
    const blocks = await readBlocks(await DocxPackage.load(buf))
    const texts = blocks.map((b) => b.text)
    expect(texts[0]).toBe("Báo cáo thiếu sót — Lumen import")
    // tiêu đề mục không kèm khoá máy
    for (const s of report.sections) expect(texts).toContain(s.title)
    const summary = blocks.find((b) => b.kind === "table")!.rows!
    expect(summary).toEqual([
      ["Hạng mục", "Số lượng"],
      ["Thiếu mục theo mẫu FPT (đỏ)", String(report.totals.missing_fpt_sections)],
      ["Cờ đỏ", String(report.totals.red)],
      ["Cờ vàng", String(report.totals.yellow)],
      ["Mục bắt buộc còn thiếu", String(report.totals.missing_sections)],
      ["Tiêu đề không khớp mẫu", String(report.totals.unmapped_headings)],
      ["Dữ liệu trích có độ tin thấp", String(report.totals.low_confidence_fields)],
      ["Hình chưa vẽ được", String(report.totals.unrendered_diagrams)]
    ])
    expect(texts.some((t) => t.includes("5.9 Team Notes"))).toBe(true)
    // báo cáo thật (Spine + profile từ import) không lọt mã máy
    const all = texts.join("\n")
    for (const raw of ["fixed:", "feature:", "custom:", "[id=", "section_empty", "import_semantic"]) expect(all).not.toContain(raw)
    expect(all).not.toMatch(/\bB\d{4}\b/)
  })

  it("giao báo cáo lần đầu ⇒ delivered; lần sau không đổi; vẫn xem được báo cáo", async () => {
    const { projectId, importId } = await importFinalized()
    await markDelivered(projectId)
    expect((await ImportedDocument.findById(importId).lean())?.status).toBe("delivered")
    await markDelivered(projectId)
    expect((await ImportedDocument.findById(importId).lean())?.status).toBe("delivered")
    expect((await buildGapReport(projectId)).project_id).toBe(projectId)
  })
})
