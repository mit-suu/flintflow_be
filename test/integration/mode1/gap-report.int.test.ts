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
  waived_at_version: null,
  kept_reason: null,
  kept_by: null,
  kept_at: null
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
      low_confidence_fields: report.low_confidence_fields.length,
      unrendered_diagrams: report.unrendered_diagrams.length
    })
    // chỉ FL902 (test đặt) — đầu mục FPT file không có không còn là cờ đỏ
    expect(report.totals.red).toBe(1)
    expect(report.doc_version).toBe("0.1")
  })

  it("FLF-312: không liệt kê mục FPT thiếu; cờ + mục xếp theo layout file upload; mục riêng loại custom, phần nối không liệt kê", async () => {
    const { projectId } = await importFinalized()
    await seedFlags(projectId)
    const report = gapReportSchema.parse(await buildGapReport(projectId))
    const profile = (await TemplateProfile.findOne({ projectId }).lean())!
    // Mẫu FPT không bắt buộc: file thiếu Screens Flow, Business Rules… vẫn không có phần "thiếu mục FPT"
    for (const key of ["missing_fpt_sections", "missing_sections", "unmapped_headings"]) expect(report).not.toHaveProperty(key)
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

  it("field độ tin thấp: FLF-343 tự nhận vào baseline (chưa xác nhận) vẫn liệt kê, không gồm field độ tin cao", async () => {
    const { projectId, importId } = await importFinalized()
    const report = await buildGapReport(projectId)
    expect(report.low_confidence_fields.map((f) => f.path).sort()).toEqual(["functions[id=FR-3.2.1].trigger", "functions[id=FR-3.2.2].trigger"])
    expect(report.low_confidence_fields.every((f) => f.confidence < 0.7 && !f.confirmed)).toBe(true)
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
      ["Cờ đỏ", String(report.totals.red)],
      ["Cờ vàng", String(report.totals.yellow)],
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
