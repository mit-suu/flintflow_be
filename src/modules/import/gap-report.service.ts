/**
 * Gap report (nút 1.13, UC-23): cờ đỏ/vàng gộp theo section, section bắt buộc thiếu, heading không map,
 * field độ tin thấp. Mode 1 v2 (FLF-184): "Thiếu mục FPT" (đỏ, D6) đứng đầu; cờ và mục xếp theo layout file upload;
 * mục riêng ngoài FPT liệt kê riêng, không cờ. Xuất JSON và `.docx` (báo cáo mới, dùng thư viện `docx` như mode 2 — không phải bản SRS).
 * FLF-171, plan §6 2C. Tải bản `.docx` khi đang `gap_review` ⇒ `delivered` (giao báo cáo, nhánh "không cần sửa").
 */

import { AlignmentType, Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from "docx"
import { ApiError } from "../../shared/utils/api-error.js"
import { latestDocVersion } from "../doc-version/doc-version.service.js"
import { capitalize, fieldLabel, humanizeText, pathLabel, ruleLabel, sectionLabel } from "../spine/human-labels.js"
import * as spineRepository from "../spine/spine.repository.js"
import type { Spine } from "../spine/spine.types.js"
import { ExtractionDraft } from "./extraction-draft.model.js"
import { UNMAPPED_SECTION, needsConfirm } from "./import.constants.js"
import type { GapReport, ReviewField } from "./import.dto.js"
import type { ImportStatus } from "./import.state.js"
import { latestImport, transitionImport } from "./import.service.js"
import { Mode1Error } from "./mode1.errors.js"
import { sectionTitle } from "./section-catalog.js"
import { FEATURE_SECTIONS, continuationOwnerSection } from "./step-plan.js"
import { TemplateProfile, type LayoutEntry, type StepPlanItem } from "./template-profile.model.js"

const REPORT_STATUSES: readonly ImportStatus[] = ["gap_review", "delivered", "change_requested"]

/**
 * Tiêu đề hiển thị của section. Truyền `layout` (template của project) thì **phần nối** — mục riêng tiêu đề rỗng, văn
 * xuôi mà assemble gộp vào mục trước — hiện theo mục chủ, thay vì trơ mã `custom:CS07` (nợ T5).
 * Ưu tiên chính tiêu đề người dùng viết trong file (`layout[].heading_text`) hơn tên mẫu FPT tiếng Anh. Không bao giờ
 * trả khoá thô (`fixed:9.9`, `feature:@B0012`): id lạ ⇒ nhãn chung ("Mục riêng", "Tính năng", "Chức năng", "Mục khác").
 * Dùng cho gap report, tiêu đề group CR, `section_title` của vị trí CR và CR_NO_LOCATIONS.
 */
export const titleOfSection = (
  spine: Pick<Spine, "features" | "functions"> & Partial<Pick<Spine, "custom_sections">>,
  id: string,
  layout?: readonly LayoutEntry[]
): string => {
  const own = layout?.find((l) => l.section_id === id && l.heading_text.trim())?.heading_text.trim()
  if (own) return own
  const at = id.indexOf(":")
  const kind = at >= 0 ? id.slice(0, at) : id
  const key = at >= 0 ? id.slice(at + 1) : ""
  if (id === FEATURE_SECTIONS) return "Yêu cầu chức năng (các tính năng)"
  if (kind === "custom") {
    const custom = spine.custom_sections?.find((c) => c.id === key)
    if (custom?.heading.trim()) return custom.heading.trim()
    if (!custom) return "Mục riêng"
    const owner = layout ? continuationOwnerSection(layout, id) : null
    return owner ? `Phần nối của "${titleOfSection(spine, owner, layout)}"` : "Phần nối (văn xuôi của mục trước)"
  }
  if (kind === "feature") return spine.features.find((f) => f.id === key)?.name ?? "Tính năng"
  if (kind === "function") return spine.functions.find((f) => f.id === key)?.name ?? "Chức năng"
  const title = sectionTitle(id)
  return title === id ? "Mục khác" : title
}

/** Layout template của project (mode 1) — để `titleOfSection` biết mục chủ của phần nối. */
export const loadLayout = async (projectId: string): Promise<LayoutEntry[] | undefined> => {
  const profile = await TemplateProfile.findOne({ projectId }, { layout: 1 }).lean()
  return profile?.layout?.length ? (profile.layout as LayoutEntry[]) : undefined
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
  if (!spine) throw new ApiError(404, "Không tìm thấy dữ liệu tài liệu của dự án", spineRepository.SPINE_NOT_FOUND)

  const open = spine.flags.filter((f) => f.resolved_at === null)
  const bySection = new Map<string, typeof open>()
  for (const f of open) bySection.set(f.section_id, [...(bySection.get(f.section_id) ?? []), f])
  const layout = layoutRows(profile?.layout ?? [], spine, bySection)
  const orderOf = new Map(layout.map((l) => [l.section_id, l.order]))
  const sections = [...bySection]
    .map(([section_id, flags]) => ({
      section_id,
      title: titleOfSection(spine, section_id, profile?.layout),
      flags: [...flags].sort((a, b) => (a.level === b.level ? 0 : a.level === "red" ? -1 : 1))
    }))
    .sort((a, b) => (orderOf.get(a.section_id) ?? Infinity) - (orderOf.get(b.section_id) ?? Infinity))
  const unrenderedDiagrams = unrendered(spine)
  const missingFpt = missingFptSections(profile?.step_plan ?? [], new Set(layout.map((l) => l.section_id)), spine, profile?.layout)

  const missing = (profile?.required_sections ?? []).map((section_id) => ({ section_id, title: titleOfSection(spine, section_id, profile?.layout) }))
  const unmapped = (profile?.heading_map ?? []).filter((h) => h.section_id === UNMAPPED_SECTION).map((h) => ({ block_id: h.block_id, text: h.heading_text }))
  const low: ReviewField[] = drafts.flatMap((d) =>
    d.fields
      .filter((f) => needsConfirm(f))
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
      low_confidence_fields: low.length,
      missing_fpt_sections: missingFpt.length,
      unrendered_diagrams: unrenderedDiagrams.length
    },
    missing_fpt_sections: missingFpt,
    layout,
    sections,
    unrendered_diagrams: unrenderedDiagrams,
    missing_sections: missing,
    unmapped_headings: unmapped,
    low_confidence_fields: low
  }
}

/** Hình dựng được từ Spine mode 1 — chỉ liệt kê loại có dữ liệu (không có entity thì không đòi ERD). */
const DIAGRAM_TARGETS = [
  { kind: "context", title: "Sơ đồ ngữ cảnh", has: (s: Spine) => s.actors.length > 0 },
  { kind: "usecase", title: "Sơ đồ use case", has: (s: Spine) => s.use_cases.length > 0 },
  { kind: "screen_flow", title: "Luồng màn hình", has: (s: Spine) => s.screens.length > 0 },
  { kind: "erd", title: "Sơ đồ thực thể (ERD)", has: (s: Spine) => s.entities.length > 0 }
] as const

/**
 * Nợ T4: hình đáng lẽ có mà **chưa có bản vẽ**. `render_status` chỉ có `ok`/`error`, nên "chưa vẽ" = chưa có bản ghi
 * hình nào cho loại đó — đúng trường hợp lúc import PlantUML không sẵn sàng (finalize bỏ qua bước vẽ, không cờ).
 * Không chặn baseline: người dùng bấm vẽ lại ở workspace khi có PlantUML.
 */
const unrendered = (spine: Spine): GapReport["unrendered_diagrams"] =>
  DIAGRAM_TARGETS.filter((t) => t.has(spine)).flatMap((t): GapReport["unrendered_diagrams"] => {
    const drawn = spine.diagrams.filter((d) => d.kind === t.kind)
    if (!drawn.length) return [{ diagram_id: "", kind: t.kind, section_id: "", title: t.title, reason: "not_rendered" }]
    return drawn
      .filter((d) => d.render_status === "error")
      .map((d) => ({ diagram_id: d.id, kind: t.kind, section_id: d.section, title: t.title, reason: "error" }))
  })

type FlagsBySection = Map<string, Spine["flags"]>

/** Mục theo thứ tự file upload + số cờ mở; bỏ phần nối (mục riêng tiêu đề rỗng — văn xuôi của section trước). */
const layoutRows = (layout: readonly LayoutEntry[], spine: Spine, bySection: FlagsBySection): GapReport["layout"] =>
  layout
    .filter((l) => l.heading_text.trim())
    .map((l) => {
      const flags = bySection.get(l.section_id) ?? []
      const kind = l.section_id.startsWith("custom:") ? "custom" : l.section_id.startsWith("group:") ? "group" : "fpt"
      return {
        order: l.order,
        section_id: l.section_id,
        heading: l.heading_text,
        level: l.level,
        kind,
        red: flags.filter((f) => f.level === "red").length,
        yellow: flags.filter((f) => f.level === "yellow").length
      } as const
    })

/** Đầu mục FPT thiếu theo kế hoạch step (D6) — mỗi section một dòng, step đầu tiên sở hữu nó. */
const missingFptSections = (plan: readonly StepPlanItem[], inLayout: ReadonlySet<string>, spine: Spine, layout?: readonly LayoutEntry[]): GapReport["missing_fpt_sections"] => {
  const out: GapReport["missing_fpt_sections"] = []
  const seen = new Set<string>()
  for (const item of plan) {
    if (!item.missing || item.state === "hidden") continue
    for (const section_id of item.section_ids) {
      if (seen.has(section_id)) continue
      seen.add(section_id)
      out.push({ section_id, title: titleOfSection(spine, section_id, layout), step_id: item.step_id, in_layout: inLayout.has(section_id) })
    }
  }
  return out
}

// ─── docx ────────────────────────────────────────────────────────
// Báo cáo giao cho người dùng: không in mã máy (`fixed:2.2.1`, `B0012`, `functions[id=…]`, `section_empty`, mã step).
// Khoá máy vẫn nằm nguyên trong JSON (`GapReport`) để FE tự gắn nhãn.

/** Ô nhiều dòng (`\n`) ⇒ mỗi dòng một đoạn — TextRun không tự xuống dòng. */
const cell = (text: string, bold = false): TableCell =>
  new TableCell({ children: text.split("\n").map((line) => new Paragraph({ children: [new TextRun({ text: line, bold })] })) })

const table = (header: string[], rows: string[][]): Table =>
  new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({ tableHeader: true, children: header.map((h) => cell(h, true)) }), ...rows.map((r) => new TableRow({ children: r.map((c) => cell(c)) }))]
  })

/** Giá trị trích cho người đọc: mảng ⇒ "a, b"; object ⇒ từng dòng "Nhãn: giá trị" — không in JSON. */
export const readableValue = (v: unknown): string => {
  if (v === null || v === undefined) return ""
  if (typeof v === "string") return v
  if (typeof v === "boolean") return v ? "Có" : "Không"
  if (typeof v === "number") return String(v)
  if (Array.isArray(v)) {
    const items = v.map(readableValue).filter(Boolean)
    return items.some((i) => i.includes("\n")) ? items.join("\n\n") : items.join(", ")
  }
  if (typeof v === "object") {
    return Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => [fieldLabel(k), readableValue(x)] as const)
      .filter(([, x]) => x)
      .map(([k, x]) => `${k}: ${x}`)
      .join("\n")
  }
  return String(v)
}

/** `2026-09-23T03:12:00Z` ⇒ "23/09/2026 10:12" (giờ Việt Nam). */
export const formatReportTime = (iso: string): string => {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(date)
      .map((p) => [p.type, p.value])
  )
  return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}`
}

/** Thông điệp cờ: bỏ tiền tố mã luật của dữ liệu cũ (`[ambiguity] …`), đổi path Spine còn sót thành nhãn. */
const flagText = (message: string): string => humanizeText(message.replace(/^\[[a-z_]+\]\s*/, ""))

const percent = (confidence: number): string => `${Math.round(confidence * 100)}%`

export const renderGapReportDocx = async (report: GapReport, projectName: string): Promise<Buffer> => {
  const t = report.totals
  // Tên mục theo chính báo cáo (tiêu đề trong file người dùng); không có ⇒ nhãn chung, không in khoá
  const titles = new Map<string, string>([
    ...report.missing_sections.map((m) => [m.section_id, m.title] as const),
    ...report.missing_fpt_sections.map((m) => [m.section_id, m.title] as const),
    ...report.sections.map((s) => [s.section_id, s.title] as const),
    ...report.layout.map((l) => [l.section_id, l.heading] as const)
  ])
  const sectionName = (id: string): string => titles.get(id) ?? capitalize(sectionLabel(id))
  const children: (Paragraph | Table)[] = [
    new Paragraph({ text: `Báo cáo thiếu sót — ${projectName}`, heading: HeadingLevel.TITLE }),
    new Paragraph({ children: [new TextRun({ text: `Phiên bản tài liệu ${report.doc_version} · tạo lúc ${formatReportTime(report.generated_at)}`, italics: true })] }),
    new Paragraph({ text: "Tổng quan", heading: HeadingLevel.HEADING_1 }),
    table(
      ["Hạng mục", "Số lượng"],
      [
        ["Thiếu mục theo mẫu FPT (đỏ)", String(t.missing_fpt_sections)],
        ["Cờ đỏ", String(t.red)],
        ["Cờ vàng", String(t.yellow)],
        ["Mục bắt buộc còn thiếu", String(t.missing_sections)],
        ["Tiêu đề không khớp mẫu", String(t.unmapped_headings)],
        ["Dữ liệu trích có độ tin thấp", String(t.low_confidence_fields)],
        ["Hình chưa vẽ được", String(t.unrendered_diagrams)]
      ]
    ),
    new Paragraph({ text: "Thiếu mục theo mẫu FPT", heading: HeadingLevel.HEADING_1 }),
    report.missing_fpt_sections.length
      ? table(
          ["Mục", "Tình trạng", "Cách bổ sung"],
          report.missing_fpt_sections.map((m) => [m.title, m.in_layout ? "Có tiêu đề, chưa có nội dung" : "File không có", "Bổ sung qua change request"])
        )
      : new Paragraph("Đủ mọi đầu mục mẫu FPT."),
    new Paragraph({ text: "Mục theo tài liệu", heading: HeadingLevel.HEADING_1 }),
    report.layout.length
      ? table(
          ["Mục", "Loại", "Cờ đỏ", "Cờ vàng"],
          report.layout.map((l) => [
            `${"  ".repeat(Math.max(0, l.level - 1))}${l.heading}`,
            l.kind === "custom" ? "Mục riêng (ngoài FPT)" : l.kind === "group" ? "Nhóm" : "Mẫu FPT",
            String(l.red),
            String(l.yellow)
          ])
        )
      : new Paragraph("Không có bố cục tài liệu (bản nhập trước khi có tính năng này)."),
    new Paragraph({ text: "Cờ theo mục", heading: HeadingLevel.HEADING_1 })
  ]
  if (!report.sections.length) children.push(new Paragraph("Không có cờ nào đang mở."))
  for (const s of report.sections) {
    children.push(new Paragraph({ text: s.title, heading: HeadingLevel.HEADING_2 }))
    children.push(table(["Mức", "Loại lỗi", "Nội dung"], s.flags.map((f) => [f.level === "red" ? "Đỏ" : "Vàng", ruleLabel(f.rule_id) || "Khác", flagText(f.message)])))
  }
  children.push(new Paragraph({ text: "Hình chưa vẽ được", heading: HeadingLevel.HEADING_1 }))
  children.push(
    report.unrendered_diagrams.length
      ? table(
          ["Hình", "Lý do"],
          report.unrendered_diagrams.map((d) => [d.title, d.reason === "error" ? "Vẽ lỗi" : "Chưa vẽ (công cụ vẽ sơ đồ không sẵn sàng lúc nhập)"])
        )
      : new Paragraph("Mọi hình đã có bản vẽ.")
  )
  children.push(new Paragraph({ text: "Mục bắt buộc còn thiếu", heading: HeadingLevel.HEADING_1 }))
  children.push(report.missing_sections.length ? table(["Mục"], report.missing_sections.map((m) => [m.title])) : new Paragraph("Không thiếu mục bắt buộc nào."))
  children.push(new Paragraph({ text: "Tiêu đề không khớp mẫu", heading: HeadingLevel.HEADING_1 }))
  children.push(report.unmapped_headings.length ? table(["Tiêu đề trong tài liệu"], report.unmapped_headings.map((u) => [u.text])) : new Paragraph("Mọi tiêu đề đều khớp."))
  children.push(new Paragraph({ text: "Dữ liệu trích có độ tin thấp", heading: HeadingLevel.HEADING_1 }))
  children.push(
    report.low_confidence_fields.length
      ? table(
          ["Mục", "Nội dung", "Giá trị", "Độ tin"],
          report.low_confidence_fields.map((f) => [sectionName(f.section_id), pathLabel(f.path), readableValue(f.edited_value ?? f.value), percent(f.confidence)])
        )
      : new Paragraph({ children: [new TextRun("Không có.")], alignment: AlignmentType.LEFT })
  )
  const document = new Document({ creator: "FlintFlow", title: `Báo cáo thiếu sót ${projectName}`, sections: [{ children }] })
  return Packer.toBuffer(document)
}

/** Giao báo cáo (nhánh "không cần sửa"): lần tải `.docx` đầu tiên khi đang `gap_review`. */
export const markDelivered = async (projectId: string): Promise<void> => {
  const doc = await latestImport(projectId)
  if (doc?.status === "gap_review") await transitionImport(doc, "delivered")
}
