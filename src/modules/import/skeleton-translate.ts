/**
 * FLF-456 — dịch phần khung một lần (heading, tiêu đề cột bảng, chữ hướng dẫn thật) khi file chỉ còn khung và người dùng chọn ngôn
 * ngữ khác file. Cùng lô dịch với phần còn lại của sản phẩm (`TRANSLATE_DOCUMENT`): mỗi lô một lượt giữ / trừ credit; chữ giống
 * nhau chỉ dịch một lần. Đơn vị model không dịch được giữ chữ gốc (không chặn Bắt đầu); hết credit / lỗi nhà cung cấp ⇒ ném, chưa
 * ghi gì vào file.
 */
import type { UserLocale } from "../../shared/i18n/locale.js"
import { ActionType } from "../../shared/ai/ai-action.types.js"
import { AiActionError } from "../../shared/ai/ai-action.types.js"
import { getActionCost, getOrCreateWallet, resolveWalletOrg } from "../../shared/ai/credit-reservation.service.js"
import { hashSource } from "../translation/translation-units.js"
import { acceptBatchItems, defaultTranslateDocumentExecutor, type TranslateDocumentExecutor } from "../translation/translation-run.service.js"
import { splitBatches, type BatchItem } from "../translation/translation.service.js"
import type { SkeletonUnit } from "./skeleton-language.js"

const LANGUAGE_NAMES: Record<UserLocale, string> = { vi: "Vietnamese", en: "English" }

/** Lô dịch của phần khung (chữ giống nhau gộp một). */
export const skeletonBatches = (units: readonly Pick<SkeletonUnit, "key" | "text">[]): BatchItem[][] => {
  const seen = new Map<string, BatchItem>()
  for (const u of units) {
    const sourceHash = hashSource(u.text)
    if (!seen.has(sourceHash)) seen.set(sourceHash, { key: u.key, sourceHash, text: u.text })
  }
  return splitBatches([...seen.values()])
}

/** Credit của phần dịch khung — cộng vào số báo trước khi bấm Bắt đầu. */
export const skeletonTranslationCost = async (units: readonly Pick<SkeletonUnit, "key" | "text">[]): Promise<{ batches: number; credits: number }> => {
  const batches = skeletonBatches(units).length
  return { batches, credits: batches > 0 ? batches * (await getActionCost(ActionType.TRANSLATE_DOCUMENT)) : 0 }
}

export interface SkeletonTranslateInput {
  projectId: string
  userId: string
  source: UserLocale
  target: UserLocale
  units: readonly Pick<SkeletonUnit, "key" | "text">[]
  executor?: TranslateDocumentExecutor
  /** Số credit khả dụng của ví (mặc định: ví org sở hữu dự án). Thay được khi test. */
  availableCredits?: () => Promise<number | null>
}

const walletAvailable = async (projectId: string, userId: string): Promise<number | null> => {
  const orgId = await resolveWalletOrg(projectId)
  if (!orgId) return null
  const wallet = await getOrCreateWallet(userId, undefined, orgId)
  return wallet.balance - wallet.reserved
}

/**
 * Kiểm số dư đủ cho **mọi lô** trước khi chạy lô đầu: lô 1 đã trừ credit mà lô 2 hết thì file chưa ghi nhưng credit lô 1 mất.
 * Không đủ ⇒ 402 `INSUFFICIENT_CREDIT`, chưa trừ gì.
 */
const assertEnoughForAllBatches = async (input: SkeletonTranslateInput, batches: number): Promise<void> => {
  if (batches <= 1) return
  const cost = batches * (await getActionCost(ActionType.TRANSLATE_DOCUMENT))
  const available = await (input.availableCredits ?? (() => walletAvailable(input.projectId, input.userId)))()
  if (available !== null && available < cost) {
    throw new AiActionError(402, `Không đủ credit. Yêu cầu: ${cost} credit, Khả dụng: ${available} credit.`, "INSUFFICIENT_CREDIT", { cost, available })
  }
}

/** Bản dịch theo `key` của đơn vị (đơn vị không dịch được không có trong kết quả). */
export const translateSkeleton = async (input: SkeletonTranslateInput): Promise<Map<string, string>> => {
  const executor = input.executor ?? defaultTranslateDocumentExecutor
  const byHash = new Map<string, string>()
  const batches = skeletonBatches(input.units)
  await assertEnoughForAllBatches(input, batches.length)
  for (const batch of batches) {
    let result
    try {
      result = await executor(
        {
          promptVariables: {
            source_language: LANGUAGE_NAMES[input.source],
            target_language: LANGUAGE_NAMES[input.target],
            glossary: "(none)",
            items: JSON.stringify(batch.map(({ key, text }) => ({ key, text })), null, 2)
          }
        },
        input.projectId,
        input.userId
      )
    } catch (err) {
      // Model trả sai định dạng (422): executor đã nhả credit, lô này giữ chữ gốc
      if ((err as { statusCode?: number })?.statusCode === 422) continue
      throw err
    }
    for (const a of acceptBatchItems(batch, result.data.items)) if (typeof a.text === "string") byHash.set(a.sourceHash, a.text)
  }
  return new Map(input.units.flatMap((u) => (byHash.has(hashSource(u.text)) ? [[u.key, byHash.get(hashSource(u.text))!] as [string, string]] : [])))
}
