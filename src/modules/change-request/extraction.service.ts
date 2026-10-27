/**
 * extraction.service.ts — FLF-338, business-flow §3.6.1 "Rút yêu cầu từ tài liệu thô" (lát 1: sau baseline, mode 1).
 *
 * 1. `extractRequirements`: AI đọc một tài liệu tham khảo đã parse (mã đoạn `D<n>-P<nn>`), trả danh sách yêu cầu kèm đoạn
 *    nguồn + trích dẫn + nhãn (`new / modification / duplicate / contradiction / ambiguous`) + nhóm. Code kiểm lại mã đoạn,
 *    trích dẫn và đường dẫn phần tử; nhãn chỉ là gợi ý. Một lượt `EXTRACT_REQUIREMENTS` (credit báo trước ở FE — FLF-332).
 * 2. `approveExtraction`: BA tick / bỏ (+ lý do) / trả lời câu hỏi ⇒ `planExtractionCrs` (hàm thuần) gom theo nhóm ⇒ mỗi nhóm
 *    một CR (`createCr`, nguồn `reference_document` = tên tài liệu + mã đoạn, trích dẫn là vật liệu). Mục `duplicate` không
 *    tạo CR — tài liệu thành nguồn của phần tử (`captureSources`). Mục có câu hỏi chưa trả lời ⇒ 400.
 */

import mongoose from "mongoose"
import { ActionType } from "../../shared/ai/ai-action.types.js"
import type { ExtractRequirementsOutput } from "../../shared/ai/response-parser.js"
import { formatCodedParagraphs, paragraphId, splitParagraphs } from "../../shared/ai/document-paragraphs.js"
import { ProjectDocument } from "../project/project-document.model.js"
import { assignDocCodes } from "../project/document-code.service.js"
import { captureSources, entityExists } from "../project/requirement-source.service.js"
import { withMeteredAi } from "../import/metered-ai.js"
import { Mode1Error } from "../import/mode1.errors.js"
import { stripRecord } from "../import/check.service.js"
import * as spineRepository from "../spine/spine.repository.js"
import { ApiError } from "../../shared/utils/api-error.js"
import type { Spine } from "../spine/spine.types.js"
import { crProjection, glossaryText, truncate } from "./cr-context.js"
import { createCr } from "./change-request.service.js"
import { CR_MATERIAL_MAX_CHARS } from "./change-request.constants.js"
import { RequirementExtraction, type IExtractionItem, type IRequirementExtraction, type ExtractionLabel } from "./requirement-extraction.model.js"

export const EXTRACTION_QUOTE_MAX = 300
export const EXTRACTION_DOCUMENT_CHARS = 60_000
/** Nhãn cần BA trả lời trước khi đưa vào CR (§3.6.1 bước 4). */
export const QUESTION_LABELS: ReadonlySet<ExtractionLabel> = new Set(["contradiction", "ambiguous"])

export interface ExtractionDecision {
  id: string
  include: boolean
  drop_reason?: string | null
  answer?: string | null
  /** Tách / gộp nhóm: nhóm mới do BA đặt; thiếu ⇒ nhóm AI đề xuất. */
  group?: string | null
}

export interface PlannedCr {
  group: string
  items: IExtractionItem[]
  answers: Map<string, string>
}

export interface ExtractionPlan {
  crs: PlannedCr[]
  /** Mục `duplicate` được tick ⇒ chỉ thêm nguồn cho phần tử. */
  duplicates: IExtractionItem[]
  dropped: { item: IExtractionItem; reason: string }[]
}

/**
 * Hàm thuần: từ danh sách + quyết định của BA ⇒ kế hoạch tạo CR. Lỗi dữ liệu (bỏ không lý do, câu hỏi chưa trả lời, id lạ)
 * ném 400 `EXTRACTION_DECISION_INVALID` kèm `meta.item_ids` để FE tô đúng mục.
 */
export const planExtractionCrs = (items: readonly IExtractionItem[], decisions: readonly ExtractionDecision[]): ExtractionPlan => {
  const byId = new Map(items.map((i) => [i.id, i]))
  const unknown = decisions.filter((d) => !byId.has(d.id)).map((d) => d.id)
  if (unknown.length) throw new Mode1Error("EXTRACTION_DECISION_INVALID", `Không có mục ${unknown.join(", ")} trong danh sách rút.`, { item_ids: unknown })
  const missing = items.filter((i) => !decisions.some((d) => d.id === i.id)).map((i) => i.id)
  if (missing.length) throw new Mode1Error("EXTRACTION_DECISION_INVALID", `Còn ${missing.length} mục chưa quyết định (đưa vào hay bỏ).`, { item_ids: missing })

  const noReason = decisions.filter((d) => !d.include && !(d.drop_reason ?? "").trim()).map((d) => d.id)
  if (noReason.length) throw new Mode1Error("EXTRACTION_DECISION_INVALID", "Bỏ mục nào phải ghi lý do.", { item_ids: noReason })
  const unanswered = decisions.filter((d) => d.include && QUESTION_LABELS.has(byId.get(d.id)!.label) && !(d.answer ?? "").trim()).map((d) => d.id)
  if (unanswered.length) throw new Mode1Error("EXTRACTION_DECISION_INVALID", "Mục mâu thuẫn / mơ hồ cần câu trả lời trước khi đưa vào change request.", { item_ids: unanswered })

  const groups = new Map<string, PlannedCr>()
  const duplicates: IExtractionItem[] = []
  const dropped: ExtractionPlan["dropped"] = []
  for (const decision of decisions) {
    const item = byId.get(decision.id)!
    if (!decision.include) {
      dropped.push({ item, reason: (decision.drop_reason ?? "").trim() })
      continue
    }
    if (item.label === "duplicate") {
      duplicates.push(item)
      continue
    }
    const group = (decision.group ?? "").trim() || item.group || item.id
    const planned = groups.get(group) ?? { group, items: [], answers: new Map<string, string>() }
    planned.items.push(item)
    if ((decision.answer ?? "").trim()) planned.answers.set(item.id, (decision.answer ?? "").trim())
    groups.set(group, planned)
  }
  return { crs: [...groups.values()], duplicates, dropped }
}

const LABEL_VI: Readonly<Record<ExtractionLabel, string>> = {
  new: "Mới",
  modification: "Sửa đổi",
  duplicate: "Trùng",
  contradiction: "Mâu thuẫn",
  ambiguous: "Mơ hồ"
}

/** Tiêu đề CR: câu đầu của mục đầu, cắt 100 ký tự. */
export const crTitleOf = (planned: PlannedCr): string => {
  const first = planned.items[0].text.trim().split(/(?<=[.!?])\s/)[0]
  return first.length > 100 ? `${first.slice(0, 97)}…` : first
}

export const crDescriptionOf = (planned: PlannedCr, documentName: string): string =>
  planned.items
    .map((i) => {
      const answer = planned.answers.get(i.id)
      const where = i.para_id ? `${documentName} · ${i.para_id}` : documentName
      return `- [${LABEL_VI[i.label]}] ${i.text}\n  Nguồn: ${where}` + (answer ? `\n  Trả lời BA: ${answer}` : "")
    })
    .join("\n")

const requireDocument = async (projectId: string, documentId: string) => {
  if (!mongoose.isValidObjectId(documentId)) throw new ApiError(404, "Không tìm thấy tài liệu tham khảo.", "DOCUMENT_NOT_FOUND")
  const doc = await ProjectDocument.findOne({ _id: documentId, projectId })
  if (!doc) throw new ApiError(404, "Không tìm thấy tài liệu tham khảo.", "DOCUMENT_NOT_FOUND")
  return doc
}

/** Đổi đầu ra model thành mục đã kiểm bằng Code: mã đoạn phải có thật, trích dẫn nằm trong đoạn, đường dẫn phần tử có trong Spine. */
export const normalizeItems = (out: ExtractRequirementsOutput, docCode: number, paragraphs: readonly string[], spine: Spine): IExtractionItem[] => {
  const seen = new Set<string>()
  const items: IExtractionItem[] = []
  for (const [index, r] of out.requirements.entries()) {
    const text = r.text.trim()
    if (!text || seen.has(text.toLowerCase())) continue
    seen.add(text.toLowerCase())
    const paraIndex = paragraphs.findIndex((_, i) => paragraphId(docCode, i) === r.source.para_id)
    const paragraph = paraIndex >= 0 ? paragraphs[paraIndex] : null
    const quoteRaw = r.source.quote.trim()
    const quote = (paragraph && quoteRaw && paragraph.includes(quoteRaw) ? quoteRaw : (paragraph ?? text)).slice(0, EXTRACTION_QUOTE_MAX)
    const hasQuestion = QUESTION_LABELS.has(r.label)
    items.push({
      id: `R${index + 1}`,
      text,
      label: r.label,
      para_id: paragraph ? r.source.para_id : null,
      quote,
      group: (r.group ?? "").trim() || `G${index + 1}`,
      entity_paths: [...new Set(r.entity_paths.filter((p) => entityExists(spine, p)))],
      question: hasQuestion ? (r.question ?? "").trim() || "Bạn muốn xử lý yêu cầu này thế nào?" : null,
      suggested_answers: hasQuestion ? r.suggested_answers.slice(0, 4) : [],
      include: null,
      drop_reason: null,
      answer: null,
      cr_id: null
    })
  }
  return items
}

export const extractRequirements = async (projectId: string, userId: string, documentId: string): Promise<IRequirementExtraction> => {
  const doc = await requireDocument(projectId, documentId)
  if (doc.parseStatus !== "success" || !doc.extractedText?.trim()) {
    throw new Mode1Error("EXTRACTION_DOCUMENT_UNREADABLE", "Tài liệu chưa đọc được chữ — tải lại file .docx / .pdf / .txt / .md.")
  }
  if (!doc.docCode) {
    await assignDocCodes(projectId)
    const again = await ProjectDocument.findById(doc._id).select("docCode").lean()
    doc.docCode = again?.docCode ?? null
  }
  if (!doc.docCode) throw new ApiError(500, "Không gán được mã tài liệu.", "DOCUMENT_CODE_MISSING")
  const existing = await RequirementExtraction.findOne({ projectId, documentId: doc._id })
  if (existing?.status === "approved") {
    throw new Mode1Error("EXTRACTION_ALREADY_APPROVED", "Danh sách rút từ tài liệu này đã được duyệt — các change request đã tạo.", { approved_at: existing.approved_at })
  }

  const record = await spineRepository.get(projectId)
  if (!record) throw new ApiError(404, "Không tìm thấy dữ liệu tài liệu của dự án.", spineRepository.SPINE_NOT_FOUND)
  const spine = stripRecord(record)
  const paragraphs = splitParagraphs(doc.extractedText)
  const result = await withMeteredAi<ExtractRequirementsOutput>({ projectId, userId, stepId: `EXTRACT:${String(doc._id)}` }, ActionType.EXTRACT_REQUIREMENTS, {
    document_name: doc.originalName,
    doc_code: `D${doc.docCode}`,
    document: truncate(formatCodedParagraphs(doc.docCode, doc.extractedText), EXTRACTION_DOCUMENT_CHARS),
    projection: crProjection(spine, doc.extractedText.slice(0, 8000)),
    glossary: glossaryText(spine)
  })
  if (!result.ok) {
    throw new Mode1Error(result.reason === "credits" ? "EXTRACTION_INSUFFICIENT_CREDIT" : "EXTRACTION_FAILED", result.userMessage, { reason: result.reason })
  }
  const items = normalizeItems(result.data, doc.docCode, paragraphs, spine)
  const saved = await RequirementExtraction.findOneAndUpdate(
    { projectId, documentId: doc._id },
    { $set: { document_name: doc.originalName, doc_code: doc.docCode, status: "extracted", items, credits: result.cost, created_by: userId, approved_at: null } },
    { upsert: true, returnDocument: "after" }
  )
  return saved!
}

export const getExtraction = async (projectId: string, documentId: string): Promise<IRequirementExtraction | null> => {
  await requireDocument(projectId, documentId)
  return RequirementExtraction.findOne({ projectId, documentId })
}

export interface ApproveExtractionInput {
  requester: string
  decisions: ExtractionDecision[]
}

export const approveExtraction = async (projectId: string, userId: string, documentId: string, input: ApproveExtractionInput): Promise<IRequirementExtraction> => {
  const extraction = await RequirementExtraction.findOne({ projectId, documentId })
  if (!extraction) throw new ApiError(404, "Chưa rút yêu cầu từ tài liệu này.", "EXTRACTION_NOT_FOUND")
  if (extraction.status === "approved") {
    throw new Mode1Error("EXTRACTION_ALREADY_APPROVED", "Danh sách này đã được duyệt — các change request đã tạo.", { approved_at: extraction.approved_at })
  }
  const plan = planExtractionCrs(extraction.items, input.decisions)
  const record = await spineRepository.get(projectId)
  const spine = record ? stripRecord(record) : null

  const crIds = new Map<string, string>()
  for (const planned of plan.crs) {
    const paraIds = [...new Set(planned.items.map((i) => i.para_id).filter((p): p is string => p !== null))]
    const cr = await createCr(projectId, userId, {
      title: crTitleOf(planned),
      description: crDescriptionOf(planned, extraction.document_name),
      source: { kind: "reference_document", ref: `${extraction.document_name}${paraIds.length ? ` · ${paraIds.join(", ")}` : ""}`.slice(0, 500), note: null },
      requester: input.requester,
      materials: planned.items.slice(0, 5).map((i) => ({ name: i.para_id ? `${extraction.document_name} ${i.para_id}` : extraction.document_name, text: i.quote.slice(0, CR_MATERIAL_MAX_CHARS) }))
    })
    for (const item of planned.items) crIds.set(item.id, cr.cr_id)
  }
  // Mục trùng: tài liệu thành nguồn của phần tử (UC-53) — lỗi chỉ ghi log, không chặn duyệt
  if (spine && plan.duplicates.length) {
    const entries = plan.duplicates.flatMap((i) => (i.para_id ? i.entity_paths.map((path) => ({ path, paras: [i.para_id!] })) : []))
    await captureSources(projectId, `EXTRACT:${documentId}`, spine, entries).catch((err: unknown) => console.warn("[extraction] không ghi được nguồn cho mục trùng:", err))
  }

  for (const item of extraction.items) {
    const decision = input.decisions.find((d) => d.id === item.id)!
    item.include = decision.include
    item.drop_reason = decision.include ? null : (decision.drop_reason ?? "").trim()
    item.answer = (decision.answer ?? "").trim() || null
    item.cr_id = crIds.get(item.id) ?? null
  }
  extraction.status = "approved"
  extraction.approved_at = new Date()
  extraction.markModified("items")
  await extraction.save()
  return extraction
}
