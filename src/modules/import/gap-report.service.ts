/**
 * Gap report (nút 1.13, UC-23): cờ đỏ/vàng gộp theo section, section bắt buộc thiếu, heading không map,
 * field độ tin thấp. Xuất JSON và `.docx` (báo cáo mới, dùng thư viện `docx` như mode 2 — không phải bản SRS).
 * FLF-171, plan §6 2C. Tải bản `.docx` khi đang `gap_review` ⇒ `delivered` (giao báo cáo, nhánh "không cần sửa").
 */

import { AlignmentType, Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from "docx"
import { ApiError } from "../../shared/utils/api-error.js"
import { latestDocVersion } from "../doc-version/doc-version.service.js"
import * as spineRepository from "../spine/spine.repository.js"
import type { Spine } from "../spine/spine.types.js"
import { ExtractionDraft } from "./extraction-draft.model.js"
import { FIELD_CONFIDENCE_THRESHOLD, UNMAPPED_SECTION } from "./import.constants.js"
import type { GapReport, ReviewField } from "./import.dto.js"
import type { ImportStatus } from "./import.state.js"
import { latestImport, transitionImport } from "./import.service.js"
import { Mode1Error } from "./mode1.errors.js"
import { sectionTitle } from "./section-catalog.js"
import { TemplateProfile } from "./template-profile.model.js"

const REPORT_STATUSES: readonly ImportStatus[] = ["gap_review", "delivered", "change_requested"]

export const titleOfSection = (spine: Pick<Spine, "features" | "functions">, id: string): string => {
  const [kind, key] = id.split(":")
  if (kind === "feature") return spine.features.find((f) => f.id === key)?.name ?? id
  if (kind === "function") return spine.functions.find((f) => f.id === key)?.name ?? id
  return sectionTitle(id)
}

export const buildGapReport = async (projectId: string): Promise<GapReport> => {
  const doc = await latestImport(projectId)
  if (!doc || !REPORT_STATUSES.includes(doc.status)) {
    throw new Mode1Error("IMPORT_INVALID_STATE", "Gap report có sau khi import xong bước check", {
      status: doc?.status ?? "uploaded",
      to: "gap_review",
      allowed: REPORT_STATUSES
    })
  }
  const [spine, profile, drafts, version] = await Promise.all([
    spineRepository.get(projectId),
    TemplateProfile.findOne({ projectId }).lean(),
    ExtractionDraft.find({ import_id: doc._id }).lean(),
    latestDocVersion(projectId)
  ])
  if (!spine) throw new ApiError(404, "Không tìm thấy Spine của dự án", spineRepository.SPINE_NOT_FOUND)

  const open = spine.flags.filter((f) => f.resolved_at === null)
  const bySection = new Map<string, typeof open>()
  for (const f of open) bySection.set(f.section_id, [...(bySection.get(f.section_id) ?? []), f])
  const sections = [...bySection].map(([section_id, flags]) => ({
    section_id,
    title: titleOfSection(spine, section_id),
    flags: [...flags].sort((a, b) => (a.level === b.level ? 0 : a.level === "red" ? -1 : 1))
  }))

  const missing = (profile?.required_sections ?? []).map((section_id) => ({ section_id, title: sectionTitle(section_id) }))
  const unmapped = (profile?.heading_map ?? []).filter((h) => h.section_id === UNMAPPED_SECTION).map((h) => ({ block_id: h.block_id, text: h.heading_text }))
  const low: ReviewField[] = drafts.flatMap((d) =>
    d.fields
      .filter((f) => f.confidence < FIELD_CONFIDENCE_THRESHOLD)
      .map((f) => ({
        section_id: d.section_id,
        path: f.path,
        value: f.value,
        confidence: f.confidence,
        source_block_ids: f.source_block_ids,
        origin: f.origin,
        confirmed: f.confirmed,
        ...(f.edited_value !== undefined ? { edited_value: f.edited_value } : {})
      }))
  )

  return {
    project_id: projectId,
    doc_version: version?.version ?? "0.0",
    generated_at: new Date().toISOString(),
    totals: {
      red: open.filter((f) => f.level === "red").length,
      yellow: open.filter((f) => f.level === "yellow").length,
      missing_sections: missing.length,
      unmapped_headings: unmapped.length,
      low_confidence_fields: low.length
    },
    sections,
    missing_sections: missing,
    unmapped_headings: unmapped,
    low_confidence_fields: low
  }
}

// ─── docx ────────────────────────────────────────────────────────

const cell = (text: string, bold = false): TableCell =>
  new TableCell({ children: [new Paragraph({ children: [new TextRun({ text, bold })] })] })

const table = (header: string[], rows: string[][]): Table =>
  new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({ tableHeader: true, children: header.map((h) => cell(h, true)) }), ...rows.map((r) => new TableRow({ children: r.map((c) => cell(c)) }))]
  })

const valueText = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v))

export const renderGapReportDocx = async (report: GapReport, projectName: string): Promise<Buffer> => {
  const t = report.totals
  const children: (Paragraph | Table)[] = [
    new Paragraph({ text: `Gap report — ${projectName}`, heading: HeadingLevel.TITLE }),
    new Paragraph({ children: [new TextRun({ text: `Version tài liệu ${report.doc_version} · tạo lúc ${report.generated_at}`, italics: true })] }),
    new Paragraph({ text: "Tổng quan", heading: HeadingLevel.HEADING_1 }),
    table(
      ["Hạng mục", "Số lượng"],
      [
        ["Cờ đỏ", String(t.red)],
        ["Cờ vàng", String(t.yellow)],
        ["Section bắt buộc thiếu", String(t.missing_sections)],
        ["Heading không khớp template", String(t.unmapped_headings)],
        ["Field độ tin thấp", String(t.low_confidence_fields)]
      ]
    ),
    new Paragraph({ text: "Cờ theo section", heading: HeadingLevel.HEADING_1 })
  ]
  if (!report.sections.length) children.push(new Paragraph("Không có cờ nào đang mở."))
  for (const s of report.sections) {
    children.push(new Paragraph({ text: `${s.title} (${s.section_id})`, heading: HeadingLevel.HEADING_2 }))
    children.push(table(["Mức", "Luật", "Nội dung"], s.flags.map((f) => [f.level === "red" ? "Đỏ" : "Vàng", f.rule_id, f.message])))
  }
  children.push(new Paragraph({ text: "Section bắt buộc thiếu", heading: HeadingLevel.HEADING_1 }))
  children.push(report.missing_sections.length ? table(["Section", "Tiêu đề"], report.missing_sections.map((m) => [m.section_id, m.title])) : new Paragraph("Không thiếu section bắt buộc nào."))
  children.push(new Paragraph({ text: "Heading không khớp template", heading: HeadingLevel.HEADING_1 }))
  children.push(report.unmapped_headings.length ? table(["Block", "Heading"], report.unmapped_headings.map((u) => [u.block_id, u.text])) : new Paragraph("Mọi heading đều khớp."))
  children.push(new Paragraph({ text: "Field độ tin thấp", heading: HeadingLevel.HEADING_1 }))
  children.push(
    report.low_confidence_fields.length
      ? table(["Field", "Giá trị", "Độ tin"], report.low_confidence_fields.map((f) => [f.path, valueText(f.edited_value ?? f.value), f.confidence.toFixed(2)]))
      : new Paragraph({ children: [new TextRun("Không có.")], alignment: AlignmentType.LEFT })
  )
  const document = new Document({ creator: "FlintFlow", title: `Gap report ${projectName}`, sections: [{ children }] })
  return Packer.toBuffer(document)
}

/** Giao báo cáo (nhánh "không cần sửa"): lần tải `.docx` đầu tiên khi đang `gap_review`. */
export const markDelivered = async (projectId: string): Promise<void> => {
  const doc = await latestImport(projectId)
  if (doc?.status === "gap_review") await transitionImport(doc, "delivered")
}
