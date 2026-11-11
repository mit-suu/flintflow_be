/**
 * FLF-375 (business-flow nguyên tắc 9 + §3.2): tin nhắn người dùng gõ trong lúc CR đang mở.
 *   - Lệnh sửa (`isChangeInstruction`, cùng luật với chat thường) ⇒ gộp vào CR như trước (`amendCr`).
 *   - Câu hỏi ("không vẽ lại hình à?") ⇒ AI **trả lời** từ dữ liệu SRS + trạng thái CR, KHÔNG thành yêu cầu bổ sung của
 *     CR. Dùng đúng action CHAT của chat thường (tính credit như chat thường), kèm tóm tắt CR: các chỗ, kết luận, lý do —
 *     gồm cả quyết định vẽ lại sơ đồ gốc.
 */

import { stripRecord } from "../import/check.service.js"
import { buildChatSpineIndex } from "../project/chat-spine-index.js"
import * as spineRepository from "../spine/spine.repository.js"
import { isChangeInstruction } from "../spine/change.service.js"
import { executeAiAction } from "../../shared/ai/ai-action.service.js"
import { ActionType } from "../../shared/ai/ai-action.types.js"
import { detectMessageLanguage, type ReplyLanguage } from "../../shared/i18n/reply-language.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { ChangeLocation } from "./change-location.model.js"
import type { IChangeRequest } from "./change-request.model.js"
import { amendCr } from "./clarify.service.js"
import { locationDisplay } from "./location-display.js"
import { isDiagramLocation } from "./diagram-location.js"

export type CrMessageOutcome = { kind: "amended" } | { kind: "answer"; reply: string }

const CONCLUSION_TEXT: Readonly<Record<string, string>> = { edit: "will change", comment: "comment only", not_related: "not changed" }

/** Tóm tắt CR cho model: tiêu đề, yêu cầu, trạng thái, từng chỗ (tên người đọc được + kết luận + lý do). */
export const crSummary = async (cr: IChangeRequest): Promise<string> => {
  const record = await spineRepository.get(String(cr.projectId))
  const spine = record ? stripRecord(record) : null
  const locations = await ChangeLocation.find({ projectId: cr.projectId, cr_id: cr.cr_id }).sort({ location_id: 1 }).lean()
  const lines = locations.map((l) => {
    const d = locationDisplay(spine, l.path, l.conclusion ?? null, l.proposal ?? null)
    const kind = isDiagramLocation(l) ? "original diagram image" : d.kind
    const verdict = l.conclusion ? CONCLUSION_TEXT[l.conclusion] : "not decided yet"
    return `- [${kind}] ${d.label || "(no title)"} — ${verdict}${l.reason ? `: ${l.reason}` : ""}`
  })
  return [
    `Open change request ${cr.cr_id}: "${cr.title}"`,
    `Request: ${cr.description}`,
    `Status: ${cr.status}`,
    "Places in the SRS this change request touches:",
    ...(lines.length ? lines : ["- (not searched yet)"])
  ].join("\n")
}

export const handleCrMessage = async (cr: IChangeRequest, userId: string, text: string, sessionLanguage: ReplyLanguage = "vi"): Promise<CrMessageOutcome> => {
  if (isChangeInstruction(text)) {
    await amendCr(cr, userId, text)
    return { kind: "amended" }
  }
  const record = await spineRepository.get(String(cr.projectId))
  if (!record) throw new ApiError(404, "Không tìm thấy dữ liệu tài liệu của dự án.", spineRepository.SPINE_NOT_FOUND)
  const replyLanguage = detectMessageLanguage(text) ?? sessionLanguage
  const result = await executeAiAction<{ reply?: unknown }>(
    ActionType.CHAT,
    {
      promptVariables: {
        step_name: `Change request ${cr.cr_id}`,
        chat_history: await crSummary(cr),
        input_text: text,
        documentContext: "",
        spine_index: buildChatSpineIndex(record) || "(empty)"
      },
      replyLanguage
    },
    String(cr.projectId),
    userId
  )
  const reply = typeof result.data?.reply === "string" ? result.data.reply : typeof result.data === "string" ? result.data : ""
  if (!reply.trim()) throw new ApiError(502, "AI chưa trả lời được câu này — thử hỏi lại", "AI_PROVIDER_ERROR")
  return { kind: "answer", reply }
}
