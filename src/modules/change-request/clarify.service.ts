/**
 * C-2 làm rõ CR (nút 3.2–3.3, UC-49). FLF-171, plan §6 2E.
 * Mơ hồ ⇒ vòng hỏi mới (`awaiting_answers`); rõ (hoặc đã hết 3 vòng) ⇒ lưu đích (entity path, từ khoá) cho C-3
 * và chuyển `impact_review`. AI lỗi / hết credit ⇒ `paused` ở `clarifying`.
 * Mode 1 v3 phase 7: "mơ hồ" gồm cả thiếu dữ kiện để viết nội dung mới — prompt kèm tài liệu bổ sung; câu trả lời
 * trống = chưa biết; đi tiếp mà còn thiếu ⇒ `missing_info` cho C-4 ghi giả định.
 */

import { ActionType } from "../../shared/ai/ai-action.types.js"
import type { CrClarifyOutput } from "../../shared/ai/response-parser.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { latestDocVersion } from "../doc-version/doc-version.service.js"
import { stripRecord } from "../import/check.service.js"
import { DocBlock } from "../import/doc-block.model.js"
import { withMeteredAi } from "../import/metered-ai.js"
import * as spineRepository from "../spine/spine.repository.js"
import type { IChangeRequest } from "./change-request.model.js"
import { assertCrStatus, transitionCr } from "./change-request.service.js"
import { AMENDABLE_CR_STATUSES, MAX_CLARIFY_ROUNDS, canAskMore } from "./change-request.state.js"
import { answersText, crHeader, crProjection, materialsText, truncate } from "./cr-context.js"
import { mentionedSections, type HeadingRef } from "./section-mention.js"

/** Tiêu đề mục của bản tài liệu mới nhất, theo thứ tự (kèm mã section đã khớp). */
const docHeadings = async (cr: IChangeRequest): Promise<HeadingRef[]> => {
  const version = await latestDocVersion(cr.projectId)
  if (!version) return []
  const headings = await DocBlock.find({ projectId: cr.projectId, doc_version: version.version, kind: "heading" })
    .sort({ "anchor.ordinal": 1 })
    .select("text section_id")
    .lean()
  return headings.map((h) => ({ text: h.text, section_id: h.section_id ?? null }))
}

const outlineText = (headings: readonly HeadingRef[]): string =>
  truncate(headings.map((h) => `${h.text}${h.section_id ? ` (${h.section_id})` : ""}`).join("\n"), 3000)

/** Chữ người yêu cầu viết: tiêu đề, mô tả, lệnh gộp thêm, câu trả lời (không lấy câu hỏi của AI). */
const requesterText = (cr: IChangeRequest): string =>
  [cr.title, cr.description, ...(cr.amendments ?? []).map((a) => a.text), ...cr.clarifications.flatMap((c) => c.answers)].join("\n")

/** Từ khoá dự phòng khi hết vòng mà model vẫn thấy mơ hồ: từ dài trong tiêu đề CR. */
const fallbackKeywords = (cr: IChangeRequest): string[] => cr.title.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 5).slice(0, 5)

export const runClarify = async (cr: IChangeRequest, userId: string): Promise<void> => {
  assertCrStatus(cr, ["draft", "clarifying"], "clarifying")
  await transitionCr(cr, "clarifying")
  const record = await spineRepository.get(String(cr.projectId))
  if (!record) throw new ApiError(404, "Không tìm thấy dữ liệu tài liệu của dự án", spineRepository.SPINE_NOT_FOUND)
  const spine = stripRecord(record)
  const round = cr.clarifications.length + 1
  // Phase 8: mỗi lần gộp thêm lệnh được hỏi lại tối đa 3 vòng (đếm từ lần gộp gần nhất)
  const lastAmendment = cr.amendments?.length ? cr.amendments[cr.amendments.length - 1] : null
  const asked = cr.clarifications.length - (lastAmendment?.after_round ?? 0)

  cr.paused = null
  const headings = await docHeadings(cr)
  const result = await withMeteredAi<CrClarifyOutput>({ projectId: String(cr.projectId), userId, stepId: `C-2:${cr.cr_id}` }, ActionType.CR_CLARIFY, {
    ...crHeader(cr),
    round: Math.min(asked + 1, MAX_CLARIFY_ROUNDS),
    clarifications: answersText(cr),
    materials: materialsText(cr),
    projection: crProjection(spine, `${cr.title}\n${cr.description}\n${answersText(cr)}\n${(cr.materials ?? []).map((m) => m.text).join("\n")}`),
    outline: outlineText(headings)
  })
  if (!result.ok) {
    cr.paused = { reason: result.reason, at: new Date() }
    await cr.save()
    return
  }
  const out = result.data
  if (out.ambiguous && canAskMore(asked)) {
    // Gợi ý song song câu hỏi — model trả thiếu / thừa thì cắt, bù `[]`; bỏ gợi ý trùng
    const suggestions = out.questions.map((_, i) => [...new Set((out.suggestions[i] ?? []).map((s) => s.trim()).filter(Boolean))])
    cr.clarifications.push({ round, questions: out.questions, answers: [], suggestions })
    await transitionCr(cr, "awaiting_answers")
    return
  }
  // Phase 7: đi tiếp mà còn thiếu dữ kiện (thường là hết vòng hỏi) ⇒ C-4 viết kèm giả định. Model vẫn thấy "mơ hồ" ở
  // vòng cuối mà không liệt kê ⇒ câu hỏi chưa được trả lời chính là dữ kiện thiếu.
  cr.missing_info = out.missing_info.length ? out.missing_info : out.ambiguous ? out.questions : []
  cr.markModified("missing_info")
  // Mục người yêu cầu gọi tên ("phần 3.1.3 Screen Authorization") luôn là đích — code nhận, không trông vào model.
  // Đã chỉ đích danh mục thì bỏ từ khoá của model: từ khoá kiểu "SCR-01", "Hộ gia đình" kéo cả tài liệu vào CR.
  const named = mentionedSections(requesterText(cr), headings)
  const keywords = named.length ? [] : out.targets.keywords.length || out.targets.entity_paths.length ? out.targets.keywords : fallbackKeywords(cr)
  // Phần tử bản xem trước đã chạm (mode 1 v3) luôn là đích — 3.4 vẫn tìm thêm vị trí liên quan như thường
  cr.targets = { entity_paths: [...new Set([...named, ...out.targets.entity_paths, ...(cr.seed?.targets ?? [])])], keywords }
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
