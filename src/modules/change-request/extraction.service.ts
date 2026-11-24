/**
 * extraction.service.ts — FLF-338, business-flow §3.6.1 "Rút yêu cầu từ tài liệu thô" (lát 1: sau baseline, mode 1).
 *
 * 1. `extractRequirements`: AI đọc một tài liệu tham khảo đã parse (mã đoạn `D<n>-P<nn>`), trả danh sách yêu cầu kèm đoạn
 *    nguồn + trích dẫn + nhãn (`new / modification / duplicate / contradiction / ambiguous / inferred`) + nhóm. Code kiểm lại
 *    mã đoạn, trích dẫn và đường dẫn phần tử; nhãn chỉ là gợi ý.
 * 2. `approveExtraction`: BA tick / bỏ (+ lý do) / trả lời câu hỏi / chọn phương án ⇒ `planExtractionCrs` (hàm thuần) gom
 *    theo nhóm ⇒ mỗi nhóm một CR (`createCr`, nguồn `reference_document` = tên tài liệu + số đoạn, trích dẫn là vật liệu). Mục
 *    `duplicate` không tạo CR — tài liệu thành nguồn của phần tử (`captureSources`). Mục có câu hỏi chưa trả lời ⇒ 400.
 *
 * FLF-449 (P6):
 * - Tài liệu dài chia lô theo đoạn (`extractionBatches`, mỗi lô ≤ `EXTRACTION_BATCH_CHARS`), mỗi lô **một** lượt AI
 *   (map), Code gộp (reduce): đánh lại nhóm, gộp trùng ý (`mergeItems`: chữ gập trùng, hoặc gần như trùng + cùng nhãn + cùng
 *   phần tử), xếp mục nói rõ trước, Suy ra sau. Không cắt im lặng, không trần 40 mục. Credit = số lô × giá một lượt
 *   (`estimateExtraction`; kiểm ví đủ cho cả lô trước khi gọi).
 * - Trước lượt AI, Code tra SRS cho từng đoạn (`extraction-lookup.ts`) và đưa ứng viên vào prompt; chỗ đã tra thành
 *   `seed.targets` của CR. CR có câu hỏi đã trả lời ⇒ `clarifications` + bỏ bước làm rõ (`clarify.service.extractionAnswered`).
 * - Nhãn Suy ra (`inference`): câu trích triệu chứng phải nằm trong đoạn, không thì bỏ mục; duyệt phải chọn phương án.
 * - Người nói, các phía của mâu thuẫn, hiện trạng / mong muốn — câu trích đều được kiểm.
 */

import mongoose from "mongoose"
import { ActionType } from "../../shared/ai/ai-action.types.js"
import type { ExtractRequirementsOutput } from "../../shared/ai/response-parser.js"
import { getActionCost, getOrCreateWallet, resolveWalletOrg } from "../../shared/ai/credit-reservation.service.js"
import { paragraphId, parseParagraphId, splitParagraphs } from "../../shared/ai/document-paragraphs.js"
import { ProjectDocument } from "../project/project-document.model.js"
import { assignDocCodes } from "../project/document-code.service.js"
import { captureSources, entityExists } from "../project/requirement-source.service.js"
import { withMeteredAi, type MeteredResult } from "../import/metered-ai.js"
import { Mode1Error } from "../import/mode1.errors.js"
import { runLimited, stripRecord } from "../import/check.service.js"
import { latestImport } from "../import/import.service.js"
import { hasBaseline } from "../import/import.state.js"
import { foldText, titleSimilarity } from "../import/text-similarity.js"
import * as spineRepository from "../spine/spine.repository.js"
import { ApiError } from "../../shared/utils/api-error.js"
import type { Spine } from "../spine/spine.types.js"
import { crProjection, glossaryText } from "./cr-context.js"
import { createCr } from "./change-request.service.js"
import { CR_MATERIAL_MAX_CHARS } from "./change-request.constants.js"
import type { CrClarification } from "./change-request.model.js"
import { vectorCandidates } from "./embedding/vector-search.js"
import { candidatesText, elementName, locatedPathsFor, lookupParagraphs, type ParagraphHits } from "./extraction-lookup.js"
import {
  RequirementExtraction,
  type ExtractionInference,
  type ExtractionLabel,
  type ExtractionSide,
  type ExtractionSituation,
  type IExtractionItem,
  type IRequirementExtraction,
  type SituationPoint
} from "./requirement-extraction.model.js"

export const EXTRACTION_QUOTE_MAX = 300
/**
 * Ngân sách chữ một lô (ký tự, tính cả mã đoạn). Bằng trần cắt cũ (60 000) ⇒ tài liệu không dài hơn vẫn đọc một lượt như
 * trước; dài hơn thì chia lô thay vì cắt im lặng.
 */
export const EXTRACTION_BATCH_CHARS = 60_000
/** @deprecated FLF-449: không còn cắt — giữ tên cho chỗ gọi cũ, bằng ngân sách một lô. */
export const EXTRACTION_DOCUMENT_CHARS = EXTRACTION_BATCH_CHARS
/** Số lượt AI chạy cùng lúc khi tài liệu nhiều lô. */
export const EXTRACTION_PARALLEL_BATCHES = 3
/**
 * Trần an toàn số mục của một bản rút sau khi gộp (thay trần 40). Chỉ để chặn bản ghi / request duyệt phình vô hạn
 * (`approveExtractionSchema` cùng trần); thực tế số mục bị chặn bởi `maxTokens` mỗi lượt.
 */
export const EXTRACTION_MAX_ITEMS = 500
/** Ngưỡng gần như trùng chữ (Dice trên token đã gập) để gộp hai mục cùng nhãn, cùng phần tử. */
export const MERGE_SIMILARITY = 0.85
/** Số phần tử tối đa gieo làm đích C-3 cho một CR từ danh sách rút. */
export const EXTRACTION_SEED_MAX = 20
/** Nhãn cần BA trả lời trước khi đưa vào CR (§3.6.1 bước 4). */
export const QUESTION_LABELS: ReadonlySet<ExtractionLabel> = new Set(["contradiction", "ambiguous"])

export interface ExtractionDecision {
  id: string
  include: boolean
  drop_reason?: string | null
  answer?: string | null
  /** Tách / gộp nhóm: nhóm mới do BA đặt; thiếu ⇒ nhóm AI đề xuất. */
  group?: string | null
  /** Mục Suy ra: chỉ số phương án BA chọn. */
  chosen_option?: number | null
}

export interface PlannedCr {
  group: string
  items: IExtractionItem[]
  answers: Map<string, string>
  /** Mục Suy ra ⇒ chỉ số phương án BA chọn. */
  options?: Map<string, number>
}

export interface ExtractionPlan {
  crs: PlannedCr[]
  /** Mục `duplicate` được tick ⇒ chỉ thêm nguồn cho phần tử. */
  duplicates: IExtractionItem[]
  dropped: { item: IExtractionItem; reason: string }[]
}

const validOption = (item: IExtractionItem, choice: number | null | undefined): boolean =>
  typeof choice === "number" && Number.isInteger(choice) && choice >= 0 && choice < (item.inference?.options.length ?? 0)

/**
 * Hàm thuần: từ danh sách + quyết định của BA ⇒ kế hoạch tạo CR. Lỗi dữ liệu (bỏ không lý do, câu hỏi chưa trả lời, Suy ra
 * chưa chọn phương án, id lạ) ném 400 `EXTRACTION_DECISION_INVALID` kèm `meta.item_ids` để FE tô đúng mục.
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
  // BF §3.6.1 bước 5: với Suy ra, BA chọn một phương án — phương án đó đi như Mới / Sửa đổi
  const unchosen = decisions.filter((d) => d.include && byId.get(d.id)!.label === "inferred" && !validOption(byId.get(d.id)!, d.chosen_option)).map((d) => d.id)
  if (unchosen.length) throw new Mode1Error("EXTRACTION_DECISION_INVALID", "Mục Suy ra cần chọn một phương án trước khi đưa vào change request.", { item_ids: unchosen })

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
    const planned = groups.get(group) ?? { group, items: [], answers: new Map<string, string>(), options: new Map<string, number>() }
    planned.items.push(item)
    if ((decision.answer ?? "").trim()) planned.answers.set(item.id, (decision.answer ?? "").trim())
    if (item.label === "inferred" && typeof decision.chosen_option === "number") planned.options!.set(item.id, decision.chosen_option)
    groups.set(group, planned)
  }
  return { crs: [...groups.values()], duplicates, dropped }
}

const LABEL_VI: Readonly<Record<ExtractionLabel, string>> = {
  new: "Mới",
  modification: "Sửa đổi",
  duplicate: "Trùng",
  contradiction: "Mâu thuẫn",
  ambiguous: "Mơ hồ",
  inferred: "Suy ra"
}

/** `D1-P03` ⇒ "đoạn 3" — chữ cho người đọc, không lộ mã đoạn (L6). Mã sai khuôn ⇒ "". */
export const paragraphLabel = (paraId: string | null | undefined): string => {
  const parsed = paraId ? parseParagraphId(paraId) : null
  return parsed ? `đoạn ${parsed.index + 1}` : ""
}

/** "minutes.txt · đoạn 2, 4" — nguồn đọc được, không mã đoạn. */
export const sourceLabel = (documentName: string, paraIds: readonly (string | null)[]): string => {
  const numbers = [...new Set(paraIds.map((p) => (p ? parseParagraphId(p) : null)).filter((p): p is NonNullable<typeof p> => p !== null).map((p) => p.index + 1))]
  return numbers.length ? `${documentName} · đoạn ${numbers.join(", ")}` : documentName
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
      const choice = planned.options?.get(i.id)
      const option = typeof choice === "number" ? i.inference?.options[choice] : undefined
      const chosen = option ? `\n  Phương án đã chọn: ${option.label}${option.description ? ` - ${option.description}` : ""}` : ""
      return `- [${LABEL_VI[i.label]}] ${i.text}${chosen}\n  Nguồn: ${sourceLabel(documentName, [i.para_id])}` + (answer ? `\n  Trả lời BA: ${answer}` : "")
    })
    .join("\n")

const requireDocument = async (projectId: string, documentId: string) => {
  if (!mongoose.isValidObjectId(documentId)) throw new ApiError(404, "Không tìm thấy tài liệu tham khảo.", "DOCUMENT_NOT_FOUND")
  const doc = await ProjectDocument.findOne({ _id: documentId, projectId })
  if (!doc) throw new ApiError(404, "Không tìm thấy tài liệu tham khảo.", "DOCUMENT_NOT_FOUND")
  return doc
}

// ─── hậu kiểm đầu ra model ───────────────────────────────────────

const squash = (s: string): string => s.replace(/\s+/g, " ").trim()
/** Câu trích nằm trong đoạn (so sau khi chuẩn hoá khoảng trắng — N2 `verifyQuote`, làm cục bộ tới khi có hàm chung). */
export const quoteIn = (paragraph: string | null | undefined, quote: string | null | undefined): boolean => {
  const q = squash(quote ?? "")
  return !!paragraph && q.length > 0 && squash(paragraph).includes(q)
}

const clipQuote = (s: string): string => squash(s).slice(0, EXTRACTION_QUOTE_MAX)

interface ParagraphRef {
  index: number
  text: string
}

const paragraphOf = (docCode: number, paragraphs: readonly string[], paraId: string | null | undefined): ParagraphRef | null => {
  const parsed = paraId ? parseParagraphId(paraId) : null
  if (!parsed || parsed.docCode !== docCode || parsed.index >= paragraphs.length) return null
  return { index: parsed.index, text: paragraphs[parsed.index] }
}

/** Câu trích có đoạn thật và nằm trong đoạn ⇒ `{ para_id, quote }` chuẩn; không ⇒ `null`. */
const verifiedSource = (docCode: number, paragraphs: readonly string[], paraId: string | null | undefined, quote: string | null | undefined) => {
  const para = paragraphOf(docCode, paragraphs, paraId)
  return para && quoteIn(para.text, quote) ? { para_id: paragraphId(docCode, para.index), quote: clipQuote(quote!) } : null
}

/** Mục tiêu dự án khớp chữ model ghi (gập dấu / hoa thường, chứa nhau) ⇒ chữ mục tiêu nguyên văn; không khớp ⇒ `null`. */
const matchGoal = (goals: readonly string[], text: string | null | undefined): string | null => {
  const t = foldText(text ?? "")
  if (!t) return null
  return goals.find((g) => {
    const f = foldText(g)
    return f.length > 0 && (f === t || f.includes(t) || t.includes(f))
  }) ?? null
}

export interface NormalizeContext {
  /** Mục tiêu dự án (`project.goals`) — không có ⇒ `serves_goal` luôn `null`. */
  goals?: readonly string[]
  /** Chữ cả tài liệu — người nói phải xuất hiện trong tài liệu. Thiếu ⇒ nối các đoạn. */
  documentText?: string
  /** Ứng viên Code đã tra theo đoạn ⇒ `located_paths` của từng mục. */
  hits?: ParagraphHits
}

const normalizeInference = (
  raw: NonNullable<ExtractRequirementsOutput["requirements"][number]["inference"]>,
  fallbackParaId: string,
  docCode: number,
  paragraphs: readonly string[],
  goals: readonly string[]
): ExtractionInference | null => {
  // Triệu chứng phải có câu trích nằm trong đoạn (AC-21.15) — trích sai / thiếu ⇒ bỏ mục, không lấy cả đoạn làm trích
  const symptom = verifiedSource(docCode, paragraphs, raw.symptom_para_id ?? fallbackParaId, raw.symptom_quote)
  if (!symptom || !raw.symptom.trim()) return null
  const list = (xs: readonly string[]) => xs.map((x) => x.trim()).filter(Boolean)
  const options = raw.options
    .filter((o) => o.label.trim())
    .slice(0, 2)
    .map((o) => ({ label: o.label.trim(), description: o.description?.trim() || null, pros: list(o.pros), cons: list(o.cons), risks: list(o.risks) }))
  if (options.length < 2) return null
  // 03 Đã chốt #3: chỉ khuyến nghị khi chắc chắn, và phải kèm lý do — thiếu lý do / chỉ số sai ⇒ hai phương án ngang nhau
  const reason = raw.recommendation_reason?.trim() || null
  const recommended = typeof raw.recommended === "number" && raw.recommended >= 0 && raw.recommended < options.length && reason ? raw.recommended : null
  return {
    symptom: raw.symptom.trim(),
    symptom_quote: symptom.quote,
    symptom_para_id: symptom.para_id,
    root_cause: raw.root_cause.trim(),
    rationale: raw.rationale.trim(),
    options,
    recommended,
    recommendation_reason: recommended === null ? null : reason,
    serves_goal: goals.length ? matchGoal(goals, raw.serves_goal) : null
  }
}

/**
 * Đổi đầu ra model thành mục đã kiểm bằng Code: mã đoạn phải có thật, trích dẫn nằm trong đoạn, đường dẫn phần tử có trong
 * Spine. Suy ra không trích được triệu chứng ⇒ bỏ mục. Người nói phải có trong tài liệu. Mâu thuẫn giữ các phía trích đúng.
 */
export const normalizeItems = (out: ExtractRequirementsOutput, docCode: number, paragraphs: readonly string[], spine: Spine, ctx: NormalizeContext = {}): IExtractionItem[] => {
  const goals = (ctx.goals ?? []).map((g) => g.trim()).filter(Boolean)
  const documentFold = foldText(ctx.documentText ?? paragraphs.join("\n"))
  const seen = new Set<string>()
  const items: IExtractionItem[] = []
  for (const [index, r] of out.requirements.entries()) {
    const text = r.text.trim()
    if (!text || seen.has(text.toLowerCase())) continue
    const para = paragraphOf(docCode, paragraphs, r.source.para_id)
    const paragraph = para?.text ?? null
    const quoteRaw = r.source.quote.trim()
    let paraId = para ? paragraphId(docCode, para.index) : null
    let quote = (paragraph && quoteIn(paragraph, quoteRaw) ? quoteRaw : (paragraph ?? text)).slice(0, EXTRACTION_QUOTE_MAX)
    let inference: ExtractionInference | null = null
    if (r.label === "inferred") {
      inference = r.inference ? normalizeInference(r.inference, r.source.para_id, docCode, paragraphs, goals) : null
      if (!inference) continue
      paraId = inference.symptom_para_id
      quote = inference.symptom_quote
    }
    seen.add(text.toLowerCase())
    const hasQuestion = QUESTION_LABELS.has(r.label)
    const speaker = r.speaker?.trim() || null
    const sides: ExtractionSide[] =
      r.label === "contradiction"
        ? r.sides.flatMap((s) => {
            const src = verifiedSource(docCode, paragraphs, s.para_id, s.quote)
            const who = s.speaker?.trim() || null
            return src ? [{ speaker: who && documentFold.includes(foldText(who)) ? who : null, ...src }] : []
          })
        : []
    const entityPaths = [...new Set(r.entity_paths.filter((p) => entityExists(spine, p)))]
    const sourceIndex = paraId ? (parseParagraphId(paraId)?.index ?? null) : null
    items.push({
      id: `R${index + 1}`,
      text,
      label: r.label,
      para_id: paraId,
      quote,
      group: (r.group ?? "").trim() || `G${index + 1}`,
      entity_paths: entityPaths,
      entity_names: entityPaths.map((p) => elementName(spine, p)),
      located_paths: ctx.hits ? locatedPathsFor(spine, ctx.hits, sourceIndex, `${text}\n${quote}`) : [],
      // Chỉ ghi người nói khi tài liệu ghi rõ (A11): tên phải xuất hiện trong tài liệu
      speaker: speaker && documentFold.includes(foldText(speaker)) ? speaker : null,
      sides,
      inference,
      question: hasQuestion ? (r.question ?? "").trim() || "Bạn muốn xử lý yêu cầu này thế nào?" : null,
      suggested_answers: hasQuestion ? r.suggested_answers.slice(0, 4) : [],
      include: null,
      drop_reason: null,
      answer: null,
      chosen_option: null,
      cr_id: null
    })
  }
  return items
}

/** Hiện trạng / mong muốn: chỉ giữ ý có câu trích đúng đoạn; gộp ý trùng chữ. */
export const normalizeSituation = (raw: ExtractRequirementsOutput["situation"], docCode: number, paragraphs: readonly string[]): ExtractionSituation => {
  const pick = (points: readonly { text: string; para_id: string | null; quote: string }[] = []): SituationPoint[] =>
    points.flatMap((p) => {
      const src = verifiedSource(docCode, paragraphs, p.para_id, p.quote)
      return src && p.text.trim() ? [{ text: p.text.trim(), ...src }] : []
    })
  return { current: pick(raw?.current), desired: pick(raw?.desired) }
}

const mergeSituations = (parts: readonly ExtractionSituation[]): ExtractionSituation => {
  const uniq = (points: SituationPoint[]) => {
    const seen = new Set<string>()
    return points.filter((p) => {
      const key = foldText(p.text)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }
  return { current: uniq(parts.flatMap((p) => p.current)), desired: uniq(parts.flatMap((p) => p.desired)) }
}

const samePaths = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|")

/** Hai mục cùng ý: chữ gập (bỏ dấu, hoa thường, dấu câu) trùng; hoặc gần như trùng + cùng nhãn + cùng phần tử. */
export const sameRequirement = (a: IExtractionItem, b: IExtractionItem): boolean => {
  const fa = foldText(a.text)
  if (fa && fa === foldText(b.text)) return true
  return a.label === b.label && samePaths(a.entity_paths, b.entity_paths) && titleSimilarity(a.text, b.text) >= MERGE_SIMILARITY
}

/**
 * Reduce các lô: nhóm mỗi lô đánh lại thành `G1…` toàn danh sách (nhóm `G1` của hai lô là hai nhóm khác nhau), gộp mục trùng ý
 * (giữ mục đầu, hợp phần tử + chỗ đã tra), xếp mục nói rõ trước, Suy ra sau, đánh lại id `R1…`, trần `EXTRACTION_MAX_ITEMS`.
 */
export const mergeItems = (batches: readonly (readonly IExtractionItem[])[], spine: Spine): IExtractionItem[] => {
  const merged: IExtractionItem[] = []
  const groupIds = new Map<string, string>()
  batches.forEach((items, b) => {
    for (const raw of items) {
      const key = `${b}:${raw.group}`
      if (!groupIds.has(key)) groupIds.set(key, `G${groupIds.size + 1}`)
      const item = { ...raw, group: groupIds.get(key)! }
      const twin = merged.find((m) => sameRequirement(m, item))
      if (!twin) {
        merged.push(item)
        continue
      }
      twin.entity_paths = [...new Set([...twin.entity_paths, ...item.entity_paths])]
      twin.located_paths = [...new Set([...(twin.located_paths ?? []), ...(item.located_paths ?? [])])]
    }
  })
  const ordered = [...merged.filter((i) => i.label !== "inferred"), ...merged.filter((i) => i.label === "inferred")]
  if (ordered.length > EXTRACTION_MAX_ITEMS) console.warn(`[extraction] ${ordered.length} mục, giữ ${EXTRACTION_MAX_ITEMS} mục đầu`)
  return ordered.slice(0, EXTRACTION_MAX_ITEMS).map((i, n) => ({ ...i, id: `R${n + 1}`, entity_names: i.entity_paths.map((p) => elementName(spine, p)) }))
}

// ─── chia lô + credit ────────────────────────────────────────────

export interface ExtractionBatch {
  /** 0-based. */
  index: number
  /** Đoạn `[start, end)` của tài liệu. */
  start: number
  end: number
}

const codedLine = (docCode: number, paragraphs: readonly string[], i: number): string => `[${paragraphId(docCode, i)}] ${paragraphs[i]}`

/**
 * Chia đoạn theo thứ tự tài liệu thành lô ≤ `budget` ký tự (dòng có mã đoạn). Một đoạn dài hơn ngân sách đứng riêng một lô,
 * không bị cắt. Tài liệu rỗng ⇒ không lô nào.
 */
export const extractionBatches = (docCode: number, paragraphs: readonly string[], budget = EXTRACTION_BATCH_CHARS): ExtractionBatch[] => {
  const out: ExtractionBatch[] = []
  let start = 0
  let size = 0
  for (let i = 0; i < paragraphs.length; i++) {
    const len = codedLine(docCode, paragraphs, i).length + 1
    if (i > start && size + len > budget) {
      out.push({ index: out.length, start, end: i })
      start = i
      size = 0
    }
    size += len
  }
  if (paragraphs.length) out.push({ index: out.length, start, end: paragraphs.length })
  return out
}

export interface ExtractionEstimate {
  batches: number
  credits: number
  cost_per_batch: number
}

/** Số lô + credit dự kiến của lượt rút (FE báo trước khi chạy — cổng credit §3.6). */
export const estimateExtraction = async (projectId: string, documentId: string): Promise<ExtractionEstimate> => {
  const doc = await requireDocument(projectId, documentId)
  const cost = await getActionCost(ActionType.EXTRACT_REQUIREMENTS)
  if (doc.parseStatus !== "success" || !doc.extractedText?.trim()) return { batches: 0, credits: 0, cost_per_batch: cost }
  const batches = extractionBatches(doc.docCode ?? 1, splitParagraphs(doc.extractedText)).length
  return { batches, credits: batches * cost, cost_per_batch: cost }
}

/** Ví của org sở hữu dự án phải đủ cho mọi lô trước khi gọi lượt đầu — không trừ dở chừng rồi mới báo thiếu. */
const assertCreditsFor = async (projectId: string, userId: string, batches: number): Promise<void> => {
  if (batches <= 1) return // một lượt: ví tự giữ / báo thiếu như cũ
  const orgId = await resolveWalletOrg(projectId)
  if (!orgId) return
  const [wallet, cost] = await Promise.all([getOrCreateWallet(userId, undefined, orgId), getActionCost(ActionType.EXTRACT_REQUIREMENTS)])
  const available = wallet.balance - wallet.reserved
  const required = batches * cost
  if (available < required) {
    throw new Mode1Error("EXTRACTION_INSUFFICIENT_CREDIT", `Tài liệu dài, AI cần đọc ${batches} lượt (~${required} credit) nhưng ví chỉ còn ${available} credit.`, {
      reason: "credits",
      batches,
      required,
      available
    })
  }
}

/** 03 #20: tra theo nghĩa chỉ khi đã có bản gốc (index embedding đồng bộ sau baseline); trước đó chỉ từ khoá + nhắc tên. */
const vectorAllowed = async (projectId: string): Promise<boolean> => {
  const imported = await latestImport(projectId)
  return !!imported && hasBaseline(imported.status)
}

export const extractRequirements = async (projectId: string, userId: string, documentId: string): Promise<IRequirementExtraction> => {
  const doc = await requireDocument(projectId, documentId)
  if (doc.parseStatus !== "success" || !doc.extractedText?.trim()) {
    throw new Mode1Error("EXTRACTION_DOCUMENT_UNREADABLE", "Tài liệu chưa đọc được chữ - tải lại file .docx / .pdf / .txt / .md.")
  }
  if (!doc.docCode) {
    await assignDocCodes(projectId)
    const again = await ProjectDocument.findById(doc._id).select("docCode").lean()
    doc.docCode = again?.docCode ?? null
  }
  if (!doc.docCode) throw new ApiError(500, "Không gán được mã tài liệu.", "DOCUMENT_CODE_MISSING")
  const docCode = doc.docCode
  const existing = await RequirementExtraction.findOne({ projectId, documentId: doc._id })
  if (existing?.status === "approved") {
    throw new Mode1Error("EXTRACTION_ALREADY_APPROVED", "Danh sách rút từ tài liệu này đã được duyệt - các change request đã tạo.", { approved_at: existing.approved_at })
  }

  const record = await spineRepository.get(projectId)
  if (!record) throw new ApiError(404, "Không tìm thấy dữ liệu tài liệu của dự án.", spineRepository.SPINE_NOT_FOUND)
  const spine = stripRecord(record)
  const paragraphs = splitParagraphs(doc.extractedText)
  const batches = extractionBatches(docCode, paragraphs)
  await assertCreditsFor(projectId, userId, batches.length)

  // Code tra SRS cho từng đoạn trước lượt AI (một lượt AI mỗi lô — 03 #16)
  const hits = await lookupParagraphs(spine, paragraphs, (await vectorAllowed(projectId)) ? { vector: (text) => vectorCandidates(projectId, text) } : {})
  const goals = (spine.project.goals ?? []).map((g) => g.trim()).filter(Boolean)
  const glossary = glossaryText(spine)
  const range = (b: ExtractionBatch) => Array.from({ length: b.end - b.start }, (_, k) => b.start + k)

  const results = await runLimited(batches, EXTRACTION_PARALLEL_BATCHES, (b): Promise<MeteredResult<ExtractRequirementsOutput>> => {
    const indices = range(b)
    return withMeteredAi<ExtractRequirementsOutput>(
      { projectId, userId, stepId: batches.length > 1 ? `EXTRACT:${String(doc._id)}:${b.index + 1}` : `EXTRACT:${String(doc._id)}` },
      ActionType.EXTRACT_REQUIREMENTS,
      {
        document_name: doc.originalName,
        doc_code: `D${docCode}`,
        part:
          batches.length > 1
            ? `This call covers part ${b.index + 1} of ${batches.length} (paragraphs ${paragraphId(docCode, b.start)} to ${paragraphId(docCode, b.end - 1)}); the other parts are read in separate calls.`
            : "",
        document: indices.map((i) => codedLine(docCode, paragraphs, i)).join("\n"),
        candidates: candidatesText(spine, hits, indices, (i) => paragraphId(docCode, i)),
        projection: crProjection(spine, indices.map((i) => paragraphs[i]).join("\n")),
        goals: goals.map((g) => `- ${g}`).join("\n") || "(none)",
        glossary
      }
    )
  })
  // Lô nào lỗi ⇒ cả lượt rút lỗi (hết credit được báo trước); lô đã xong vẫn đã trừ credit
  const failure = results.reduce<Extract<MeteredResult<ExtractRequirementsOutput>, { ok: false }> | null>(
    (acc, r) => (r && !r.ok && (!acc || r.reason === "credits") ? r : acc),
    null
  )
  if (failure || results.some((r) => !r)) {
    const reason = failure?.reason ?? "resume_later"
    throw new Mode1Error(reason === "credits" ? "EXTRACTION_INSUFFICIENT_CREDIT" : "EXTRACTION_FAILED", failure?.userMessage ?? "AI chưa đọc xong tài liệu - thử lại sau.", { reason })
  }
  const done = results as Extract<MeteredResult<ExtractRequirementsOutput>, { ok: true }>[]
  const ctx: NormalizeContext = { goals, documentText: doc.extractedText, hits }
  const items = mergeItems(
    done.map((r) => normalizeItems(r.data, docCode, paragraphs, spine, ctx)),
    spine
  )
  const situation = mergeSituations(done.map((r) => normalizeSituation(r.data.situation, docCode, paragraphs)))
  const credits = done.reduce((sum, r) => sum + r.cost, 0)
  const saved = await RequirementExtraction.findOneAndUpdate(
    { projectId, documentId: doc._id },
    {
      $set: { document_name: doc.originalName, doc_code: docCode, status: "extracted", situation, items, batches: batches.length, credits, created_by: userId, approved_at: null }
    },
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

/** Đích C-3 gieo cho CR: phần tử AI chỉ ra ∪ chỗ Code đã tra, còn trong Spine hiện tại. */
export const seedTargetsOf = (planned: PlannedCr, spine: Spine | null): string[] =>
  spine
    ? [...new Set(planned.items.flatMap((i) => [...i.entity_paths, ...(i.located_paths ?? [])]))].filter((p) => entityExists(spine, p)).slice(0, EXTRACTION_SEED_MAX)
    : []

/** Câu hỏi của thẻ hỏi mà BA đã trả lời ⇒ một vòng làm rõ của CR (câu hỏi, câu trả lời, gợi ý cùng thứ tự). */
export const answeredClarification = (planned: PlannedCr): CrClarification | null => {
  const asked = planned.items.filter((i) => i.question && planned.answers.has(i.id))
  if (!asked.length) return null
  return { round: 1, questions: asked.map((i) => i.question!), answers: asked.map((i) => planned.answers.get(i.id)!), suggestions: asked.map((i) => [...i.suggested_answers]) }
}

export const approveExtraction = async (projectId: string, userId: string, documentId: string, input: ApproveExtractionInput): Promise<IRequirementExtraction> => {
  const extraction = await RequirementExtraction.findOne({ projectId, documentId })
  if (!extraction) throw new ApiError(404, "Chưa rút yêu cầu từ tài liệu này.", "EXTRACTION_NOT_FOUND")
  if (extraction.status === "approved") {
    throw new Mode1Error("EXTRACTION_ALREADY_APPROVED", "Danh sách này đã được duyệt - các change request đã tạo.", { approved_at: extraction.approved_at })
  }
  const plan = planExtractionCrs(extraction.items, input.decisions)
  const record = await spineRepository.get(projectId)
  const spine = record ? stripRecord(record) : null

  const crIds = new Map<string, string>()
  for (const planned of plan.crs) {
    const targets = seedTargetsOf(planned, spine)
    const clarification = answeredClarification(planned)
    const cr = await createCr(
      projectId,
      userId,
      {
        title: crTitleOf(planned),
        description: crDescriptionOf(planned, extraction.document_name),
        source: { kind: "reference_document", ref: sourceLabel(extraction.document_name, planned.items.map((i) => i.para_id)).slice(0, 500), note: null },
        requester: input.requester,
        materials: planned.items.slice(0, 5).map((i) => ({ name: sourceLabel(extraction.document_name, [i.para_id]).slice(0, 200), text: i.quote.slice(0, CR_MATERIAL_MAX_CHARS) }))
      },
      {
        // BF §3.6.1: CR đi tiếp với các chỗ đã tra; đã hỏi ở thẻ hỏi ⇒ bỏ bước làm rõ
        seed: targets.length ? { instruction: null, ops: [], targets, skip_clarify: clarification !== null } : null,
        clarifications: clarification ? [clarification] : []
      }
    )
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
    item.chosen_option = item.label === "inferred" && decision.include && typeof decision.chosen_option === "number" ? decision.chosen_option : null
    item.cr_id = crIds.get(item.id) ?? null
  }
  extraction.status = "approved"
  extraction.approved_at = new Date()
  extraction.markModified("items")
  await extraction.save()
  return extraction
}
