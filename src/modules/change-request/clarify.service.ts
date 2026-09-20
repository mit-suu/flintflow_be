/**
 * C-2 làm rõ CR (nút 3.2–3.3, UC-49). FLF-171, plan §6 2E.
 * Mơ hồ ⇒ vòng hỏi mới (`awaiting_answers`); rõ (hoặc đã hết 3 vòng) ⇒ lưu đích (entity path, từ khoá) cho C-3
 * và chuyển `impact_review`. AI lỗi / hết credit ⇒ `paused` ở `clarifying`.
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
import { MAX_CLARIFY_ROUNDS, canAskMore } from "./change-request.state.js"
import { answersText, crHeader, crProjection, truncate } from "./cr-context.js"

const outline = async (cr: IChangeRequest): Promise<string> => {
  const version = await latestDocVersion(cr.projectId)
  if (!version) return ""
  const headings = await DocBlock.find({ projectId: cr.projectId, doc_version: version.version, kind: "heading" })
    .sort({ "anchor.ordinal": 1 })
    .select("text section_id")
    .lean()
  return truncate(headings.map((h) => `${h.text}${h.section_id ? ` (${h.section_id})` : ""}`).join("\n"), 3000)
}

/** Từ khoá dự phòng khi hết vòng mà model vẫn thấy mơ hồ: từ dài trong tiêu đề CR. */
const fallbackKeywords = (cr: IChangeRequest): string[] => cr.title.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 5).slice(0, 5)

export const runClarify = async (cr: IChangeRequest, userId: string): Promise<void> => {
  assertCrStatus(cr, ["draft", "clarifying"], "clarifying")
  await transitionCr(cr, "clarifying")
  const record = await spineRepository.get(String(cr.projectId))
  if (!record) throw new ApiError(404, "Không tìm thấy Spine của dự án", spineRepository.SPINE_NOT_FOUND)
  const spine = stripRecord(record)
  const round = cr.clarifications.length + 1

  cr.paused = null
  const result = await withMeteredAi<CrClarifyOutput>({ projectId: String(cr.projectId), userId, stepId: `C-2:${cr.cr_id}` }, ActionType.CR_CLARIFY, {
    ...crHeader(cr),
    round: Math.min(round, MAX_CLARIFY_ROUNDS),
    clarifications: answersText(cr),
    projection: crProjection(spine, `${cr.title}\n${cr.description}\n${answersText(cr)}`),
    outline: await outline(cr)
  })
  if (!result.ok) {
    cr.paused = { reason: result.reason, at: new Date() }
    await cr.save()
    return
  }
  const out = result.data
  if (out.ambiguous && canAskMore(cr.clarifications.length)) {
    cr.clarifications.push({ round, questions: out.questions, answers: [] })
    await transitionCr(cr, "awaiting_answers")
    return
  }
  const keywords = out.targets.keywords.length || out.targets.entity_paths.length ? out.targets.keywords : fallbackKeywords(cr)
  cr.targets = { entity_paths: out.targets.entity_paths, keywords }
  cr.markModified("targets")
  await transitionCr(cr, "impact_review")
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
