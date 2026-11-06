/**
 * C-2 làm rõ CR (nút 3.2–3.3, UC-49). FLF-171, plan §6 2E.
 * Mơ hồ ⇒ vòng hỏi mới (`awaiting_answers`); rõ (hoặc đã hết 3 vòng) ⇒ lưu đích (entity path, từ khoá) cho C-3
 * và chuyển `impact_review`. AI lỗi / hết credit ⇒ `paused` ở `clarifying`.
 * Mode 1 v3 phase 7: "mơ hồ" gồm cả thiếu dữ kiện để viết nội dung mới — prompt kèm tài liệu bổ sung; câu trả lời
 * trống = chưa biết; đi tiếp mà còn thiếu ⇒ `missing_info` cho C-4 ghi giả định.
 * FLF-367: CR mâu thuẫn với tài liệu (Spine mọi section, đoạn văn giữ nguyên) ⇒ câu hỏi mâu thuẫn trích cả hai phía,
 * hỏi cả khi đã hết `MAX_CLARIFY_ROUNDS`; câu đã hỏi không hỏi lại.
 */

import { ActionType } from "../../shared/ai/ai-action.types.js"
import type { CrClarifyOutput } from "../../shared/ai/response-parser.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { latestDocVersion } from "../doc-version/doc-version.service.js"
import { stripRecord } from "../import/check.service.js"
import { DocBlock } from "../import/doc-block.model.js"
import { withMeteredAi } from "../import/metered-ai.js"
import { listSections } from "../spine/section-registry.js"
import * as spineRepository from "../spine/spine.repository.js"
import type { Spine } from "../spine/spine.types.js"
import { approvedBatch } from "./add-use-case.service.js"
import type { IChangeRequest } from "./change-request.model.js"
import { assertCrStatus, transitionCr } from "./change-request.service.js"
import { AMENDABLE_CR_STATUSES, MAX_CLARIFY_ROUNDS, canAskMore } from "./change-request.state.js"
import { answersText, crHeader, crProjection, materialsText, truncate } from "./cr-context.js"
import { mentionedSections, type HeadingRef } from "./section-mention.js"
import { gapContextFor } from "./gap-fill.service.js"

/**
 * Tiêu đề mục của bản tài liệu mới nhất, theo thứ tự (kèm mã section đã khớp). Dự án chuyển từ mode 2 (FLF-318) không
 * có file upload nên không có `DocBlock` ⇒ mục lục theo mẫu FPT từ Spine.
 */
const docHeadings = async (cr: IChangeRequest, spine: Spine): Promise<HeadingRef[]> => {
  const version = await latestDocVersion(cr.projectId)
  if (!version) return []
  const headings = await DocBlock.find({ projectId: cr.projectId, doc_version: version.version, kind: "heading" })
    .sort({ "anchor.ordinal": 1 })
    .select("text section_id")
    .lean()
  if (!headings.length) return listSections(spine).map((sec) => ({ text: sec.title_en, section_id: sec.id }))
  return headings.map((h) => ({ text: h.text, section_id: h.section_id ?? null }))
}

const outlineText = (headings: readonly HeadingRef[]): string =>
  truncate(headings.map((h) => `${h.text}${h.section_id ? ` (${h.section_id})` : ""}`).join("\n"), 3000)

/** Chữ người yêu cầu viết: tiêu đề, mô tả, lệnh gộp thêm, câu trả lời (không lấy câu hỏi của AI). */
const requesterText = (cr: IChangeRequest): string =>
  [cr.title, cr.description, ...(cr.amendments ?? []).map((a) => a.text), ...cr.clarifications.flatMap((c) => c.answers)].join("\n")

/** Lựa chọn mặc định cho câu hỏi mâu thuẫn (FLF-367) khi model không gợi ý; người dùng vẫn tự gõ được ("khác"). */
export const CONTRADICTION_CHOICES = ["Đổi theo CR và sửa cả chỗ cũ", "Giữ như cũ, không áp dụng phần này của CR"] as const

const questionKey = (q: string): string => q.replace(/\s+/g, " ").trim().toLowerCase()

/** Câu hỏi mâu thuẫn chưa từng hỏi (so mọi vòng trước) kèm gợi ý; model không gợi ý ⇒ lựa chọn mặc định. */
export const newContradictions = (
  cr: Pick<IChangeRequest, "clarifications">,
  found: readonly { question: string; suggestions: readonly string[] }[]
): { question: string; suggestions: string[] }[] => {
  const seen = new Set(cr.clarifications.flatMap((c) => c.questions.map(questionKey)))
  const out: { question: string; suggestions: string[] }[] = []
  for (const c of found) {
    const key = questionKey(c.question)
    if (!key || seen.has(key)) continue
    seen.add(key)
    const suggestions = [...new Set(c.suggestions.map((s) => s.trim()).filter(Boolean))]
    out.push({ question: c.question.trim(), suggestions: suggestions.length ? suggestions : [...CONTRADICTION_CHOICES] })
  }
  return out
}

/** Từ khoá dự phòng khi hết vòng mà model vẫn thấy mơ hồ: từ dài trong tiêu đề CR. */
const fallbackKeywords = (cr: IChangeRequest): string[] => cr.title.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 5).slice(0, 5)

export const runClarify = async (cr: IChangeRequest, userId: string): Promise<void> => {
  assertCrStatus(cr, ["draft", "clarifying"], "clarifying")
  await transitionCr(cr, "clarifying")
  const record = await spineRepository.get(String(cr.projectId))
  if (!record) throw new ApiError(404, "Không tìm thấy dữ liệu tài liệu của dự án.", spineRepository.SPINE_NOT_FOUND)
  const spine = stripRecord(record)
  const round = cr.clarifications.length + 1
  // Phase 8: mỗi lần gộp thêm lệnh được hỏi lại tối đa 3 vòng (đếm từ lần gộp gần nhất)
  const lastAmendment = cr.amendments?.length ? cr.amendments[cr.amendments.length - 1] : null
  const asked = cr.clarifications.length - (lastAmendment?.after_round ?? 0)

  cr.paused = null
  // FLF-318: CR tạo từ bản xem trước đã duyệt (thêm / xoá / sửa use case) ⇒ câu hỏi đã hỏi trong chat như trước
  // baseline, lô đã chốt ⇒ không hỏi thêm, không gọi model; C-3 lấy vị trí theo đúng lô
  if (approvedBatch(spine, cr)) {
    cr.missing_info = []
    cr.markModified("missing_info")
    cr.targets = { entity_paths: [...new Set(cr.seed?.targets ?? [])], keywords: [] }
    cr.markModified("targets")
    await transitionCr(cr, "impact_review")
    return
  }
  const headings = await docHeadings(cr, spine)
  // FLF-382: CR bổ sung — đích là đúng các mục còn trống; ngữ cảnh từng mục (hướng dẫn mẫu, nội dung nên có, skill)
  const gapFill = cr.kind === "gap_fill" && (cr.gap_sections ?? []).length > 0
  const gapSections = gapFill ? await gapContextFor(cr, spine) : ""
  // Mục người yêu cầu gọi tên ("phần 3.1.3 Screen Authorization") luôn là đích — code nhận, không trông vào model.
  const named = gapFill ? [...cr.gap_sections] : mentionedSections(requesterText(cr), headings)
  const result = await withMeteredAi<CrClarifyOutput>({ projectId: String(cr.projectId), userId, stepId: `C-2:${cr.cr_id}` }, ActionType.CR_CLARIFY, {
    ...crHeader(cr),
    round: Math.min(asked + 1, MAX_CLARIFY_ROUNDS),
    clarifications: answersText(cr),
    materials: materialsText(cr),
    // FLF-367: kèm BR / NFR và đoạn văn giữ nguyên liên quan (theo cụm từ của CR hoặc mục được gọi tên) để thấy mâu thuẫn
    projection: crProjection(spine, `${cr.title}\n${crHeader(cr).description}\n${answersText(cr)}\n${(cr.materials ?? []).map((m) => m.text).join("\n")}`, {
      sections: named
    }),
    outline: outlineText(headings),
    gap_sections: gapSections
  })
  if (!result.ok) {
    cr.paused = { reason: result.reason, at: new Date() }
    await cr.save()
    return
  }
  const out = result.data
  // FLF-367: mâu thuẫn hỏi cả khi đã hết vòng làm rõ (không qua `canAskMore`), đứng trước câu hỏi mơ hồ
  const contradictions = newContradictions(cr, out.contradictions)
  const askAmbiguous = out.ambiguous && canAskMore(asked)
  if (askAmbiguous || contradictions.length) {
    // Gợi ý song song câu hỏi — model trả thiếu / thừa thì cắt, bù `[]`; bỏ gợi ý trùng
    const ambiguous = askAmbiguous ? out.questions : []
    const suggestions = ambiguous.map((_, i) => [...new Set((out.suggestions[i] ?? []).map((s) => s.trim()).filter(Boolean))])
    cr.clarifications.push({
      round,
      questions: [...contradictions.map((c) => c.question), ...ambiguous],
      answers: [],
      suggestions: [...contradictions.map((c) => c.suggestions), ...suggestions]
    })
    await transitionCr(cr, "awaiting_answers")
    return
  }
  // Phase 7: đi tiếp mà còn thiếu dữ kiện (thường là hết vòng hỏi) ⇒ C-4 viết kèm giả định. Model vẫn thấy "mơ hồ" ở
  // vòng cuối mà không liệt kê ⇒ câu hỏi chưa được trả lời chính là dữ kiện thiếu.
  cr.missing_info = out.missing_info.length ? out.missing_info : out.ambiguous ? out.questions : []
  cr.markModified("missing_info")
  // Đã chỉ đích danh mục thì bỏ từ khoá của model: từ khoá kiểu "SCR-01", "Hộ gia đình" kéo cả tài liệu vào CR.
  const keywords = named.length ? [] : out.targets.keywords.length || out.targets.entity_paths.length ? out.targets.keywords : fallbackKeywords(cr)
  // Phần tử bản xem trước đã chạm (mode 1 v3) luôn là đích — 3.4 vẫn tìm thêm vị trí liên quan như thường
  // CR bổ sung: C-3 dựng vị trí từ `gap_sections` (`gapFillLocations`) — đích của model không thêm vị trí nào
  cr.targets = gapFill
    ? { entity_paths: [...cr.gap_sections], keywords: [] }
    : { entity_paths: [...new Set([...named, ...out.targets.entity_paths, ...(cr.seed?.targets ?? [])])], keywords }
  cr.markModified("targets")
  await transitionCr(cr, "impact_review")
}

/**
 * Phase 8 (chat): gộp thêm một lệnh sửa vào CR chưa nộp. `draft` ⇒ chỉ ghi lại (bước làm rõ đầu tiên đọc luôn); sau đó ⇒
 * quay lại 3.2 (khoá giữ nguyên, vị trí + đề xuất cũ giữ nguyên; C-3 chỉ cộng thêm vị trí mới).
 */
export const amendCr = async (cr: IChangeRequest, userId: string, instruction: string): Promise<void> => {
  assertCrStatus(cr, AMENDABLE_CR_STATUSES, "clarifying")
  cr.amendments.push({ text: instruction, at: new Date(), after_round: cr.clarifications.length })
  cr.markModified("amendments")
  cr.paused = null
  await cr.save()
  if (cr.status === "draft") return
  await transitionCr(cr, "clarifying")
  await runClarify(cr, userId)
}

/** UC-49: trả lời đúng số câu hỏi của vòng đang chờ rồi chạy lại C-2. */
export const answerClarification = async (cr: IChangeRequest, userId: string, answers: string[]): Promise<void> => {
  assertCrStatus(cr, ["awaiting_answers"], "clarifying")
  const last = cr.clarifications[cr.clarifications.length - 1]
  if (!last || answers.length !== last.questions.length) {
    throw new ApiError(400, `Cần ${last?.questions.length ?? 0} câu trả lời theo đúng thứ tự câu hỏi`, "VALIDATION_ERROR")
  }
  last.answers = answers
  cr.markModified("clarifications")
  await transitionCr(cr, "clarifying")
  await runClarify(cr, userId)
}
