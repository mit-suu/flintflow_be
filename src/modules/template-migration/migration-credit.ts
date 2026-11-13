/**
 * Ước tính credit của một lần đổi mẫu (BR-01: báo trước, không trừ ở bước chuẩn bị) — hàm thuần.
 *
 *  - Dịch (D9): theo số ký tự cần dịch, chia lô như lớp dịch hiện có (`BATCH_MAX_CHARS` ký tự / lô, giá `TRANSLATE_DOCUMENT` mỗi lô).
 *  - `move_to` vào mục có cấu trúc và `ai_resolve`: mỗi mục một lượt đề xuất (giá `TEMPLATE_MIGRATION_RESOLVE`) — số ước tính, không phải giá chốt.
 * Nhóm hoá không bao giờ gọi AI; chỉ các lựa chọn của BA mới sinh chi phí, và chi phí chỉ phát sinh ở bước áp dụng.
 */
import { ActionType } from "../../shared/ai/ai-action.types.js"
import { getActionCost } from "../../shared/ai/credit-reservation.service.js"
import { BATCH_MAX_CHARS } from "../translation/translation.service.js"
import { decidableItems, type DecisionLike, type MigrationGroups } from "./classify.js"

export interface MigrationCostInput {
  translation_chars: number
  structural_moves: number
  ai_resolve: number
}

export interface MigrationUnitCosts {
  translate_batch: number
  ai_item: number
}

export interface MigrationCreditEstimate {
  translation: { chars: number; batches: number; credits: number }
  structural_moves: { count: number; credits: number }
  ai_resolve: { count: number; credits: number }
  total: number
}

export const estimateMigrationCredits = (input: MigrationCostInput, costs: MigrationUnitCosts): MigrationCreditEstimate => {
  const batches = input.translation_chars > 0 ? Math.ceil(input.translation_chars / BATCH_MAX_CHARS) : 0
  const translation = { chars: input.translation_chars, batches, credits: batches * costs.translate_batch }
  const structural_moves = { count: input.structural_moves, credits: input.structural_moves * costs.ai_item }
  const ai_resolve = { count: input.ai_resolve, credits: input.ai_resolve * costs.ai_item }
  return { translation, structural_moves, ai_resolve, total: translation.credits + structural_moves.credits + ai_resolve.credits }
}

/** Số lựa chọn cần AI trong các quyết định hiện có: `move_to` vào mục có cấu trúc, và `ai_resolve`. */
export const aiChoiceCounts = (groups: MigrationGroups, decisions: readonly DecisionLike[]): { structural_moves: number; ai_resolve: number } => {
  const items = decidableItems(groups)
  let structural_moves = 0
  let ai_resolve = 0
  for (const d of decisions) {
    const item = items.get(d.id)
    if (!item?.ai_choices.includes(d.choice)) continue
    if (d.choice === "ai_resolve") ai_resolve++
    else structural_moves++
  }
  return { structural_moves, ai_resolve }
}

export const loadMigrationUnitCosts = async (): Promise<MigrationUnitCosts> => ({
  translate_batch: await getActionCost(ActionType.TRANSLATE_DOCUMENT),
  ai_item: await getActionCost(ActionType.TEMPLATE_MIGRATION_RESOLVE)
})
