/**
 * translation-run.service.ts
 * ─────────────────────────────────────────────────────────────────
 * Dịch theo lô phần CÒN THIẾU (FLF-265 §2.4, D9 D10 Q7) — `POST /projects/:id/translations/run`.
 * Dùng khi: đổi ngôn ngữ dự án đang có nội dung; câu lượt AI không trả kèm; ghi Spine không qua AI.
 *
 * - Mỗi lô một lượt `executeAiAction(TRANSLATE_DOCUMENT)` ⇒ giữ / trừ credit theo lô (Flow 4). Parse lỗi ⇒ executor
 *   nhả credit, lô đó không ghi gì.
 * - Lô gửi CHỈ `{key, text}` của lô + glossary con (thuật ngữ có trong lô) — không nạp Spine vào prompt.
 * - Kết quả kiểm theo lô đã gửi: key lạ ⇒ bỏ; thiếu key ⇒ giữ thiếu; sai kiểu / mảng khác độ dài ⇒ bỏ đơn vị đó.
 * - Lưu `origin: "machine"` — không đè bản `author`.
 * - Lô parse lỗi (422) ⇒ bỏ qua lô đó, chạy tiếp lô sau (một lô hỏng không chặn phần còn lại); mọi lô đều parse lỗi ⇒
 *   ném lỗi đầu tiên.
 * - 402 hết credit / provider lỗi ⇒ dừng; chưa xong lô nào ⇒ ném ra (FE thấy `INSUFFICIENT_CREDIT`), đã xong ⇒ trả
 *   phần đã dịch.
 * - Lô đã trừ credit mà không nhận được đơn vị nào (`items: []`, toàn sai hình dạng) ⇒ dừng ngay, không tiêu thêm.
 *   Đơn vị model dịch hỏng mãi vẫn "thiếu" và lô đó luôn đứng đầu ⇒ FE dừng vòng lặp khi `translated = 0`
 *   (không chỉ khi `remaining = 0`), nếu không mỗi lượt gọi lại trả 2 credit mà không tiến.
 * - Một lượt mỗi (dự án, ngôn ngữ): lượt chồng lên ⇒ 409 `TRANSLATION_RUNNING`, không gọi model (không trả credit hai
 *   lần cho cùng phần thiếu).
 * - Ghi bản dịch lỗi sau khi lô đã trừ credit ⇒ dừng, trả phần đã có (giữ đúng `credits_used`); học glossary lỗi ⇒ bỏ qua.
 *   Spine không bao giờ đổi.
 */

import type { UserLocale } from "../../shared/i18n/locale.js"
import { ActionType, type AiActionInput, type AiActionResult } from "../../shared/ai/ai-action.types.js"
import { executeAiAction } from "../../shared/ai/ai-action.service.js"
import { ApiError } from "../../shared/utils/api-error.js"
import type { TranslateDocumentOutput } from "../../shared/ai/response-parser.js"
import * as spineRepository from "../spine/spine.repository.js"
import type { Spine } from "../spine/spine.types.js"
import type { DocumentLanguageProject } from "../project/document-language.js"
import * as repository from "./translation.repository.js"
import { formatGlossary, glossaryFor, learnGlossary, seedGlossary } from "./glossary.service.js"
import { copiedSource, fitTranslation, hashSource, translationUnits, type LocalizedUnit } from "./translation-units.js"
import { projectLanguages, resolveTranslations, splitBatches, uniqueBatchItems, type BatchItem } from "./translation.service.js"

export type TranslateDocumentExecutor = (
  input: AiActionInput,
  projectId: string,
  userId: string
) => Promise<AiActionResult<TranslateDocumentOutput>>

export const defaultTranslateDocumentExecutor: TranslateDocumentExecutor = (input, projectId, userId) =>
  executeAiAction<TranslateDocumentOutput>(ActionType.TRANSLATE_DOCUMENT, input, projectId, userId)

/** Mặc định số lô mỗi request (Q7) — FE gọi lại tới `remaining = 0`, dừng sớm khi `translated = 0` (lô không tiến). */
export const DEFAULT_MAX_BATCHES = 5

/** Tên ngôn ngữ trong prompt (prompt viết tiếng Anh). */
const LANGUAGE_NAMES: Record<UserLocale, string> = { vi: "Vietnamese", en: "English" }

export interface TranslationRunResult {
  translated: number
  remaining: number
  credits_used: number
}

/**
 * Giữ các item hợp lệ với lô đã gửi (`fitTranslation`). Key lạ ⇒ bỏ; key trùng ⇒ lấy lần đầu hợp lệ; chuỗi ⇔ chuỗi không
 * rỗng; mảng ⇔ mảng chuỗi cùng độ dài, phần tử có chữ không được dịch thành rỗng. Chép nguyên câu gốc (`copiedSource`)
 * ⇒ bỏ, giữ "thiếu" — cùng quy tắc với lượt AI trả kèm, không lưu tiếng Anh thành bản `machine`.
 */
export const acceptBatchItems = (batch: BatchItem[], items: TranslateDocumentOutput["items"]): LocalizedUnit[] => {
  const byKey = new Map(batch.map((item) => [item.key, item]))
  const done = new Set<string>()
  return items.flatMap(({ key, text }): LocalizedUnit[] => {
    const sent = byKey.get(key)
    if (!sent || done.has(key)) return []
    const fitted = fitTranslation(sent.text, text)
    if (fitted === null || copiedSource({ source: sent.text, text: fitted })) return []
    done.add(key)
    return [{ key, sourceHash: sent.sourceHash, source: sent.text, text: fitted }]
  })
}

const statusOf = (err: unknown): number | undefined =>
  typeof err === "object" && err !== null && "statusCode" in err ? (err as { statusCode?: number }).statusCode : undefined

/** Lô model trả sai định dạng (parser 422) — executor đã nhả credit, chỉ lô đó hỏng. */
const isParseError = (err: unknown): boolean => statusOf(err) === 422

export const TRANSLATION_RUNNING = "TRANSLATION_RUNNING"

export const runTranslation = async (
  projectId: string,
  userId: string,
  project: DocumentLanguageProject,
  options: { max_batches?: number } = {},
  executor: TranslateDocumentExecutor = defaultTranslateDocumentExecutor
): Promise<TranslationRunResult> => {
  const none: TranslationRunResult = { translated: 0, remaining: 0, credits_used: 0 }
  const { locale, source } = await projectLanguages(projectId, project)
  if (locale === source) return none
  const spine = await spineRepository.get(projectId)
  if (!spine) return none

  const token = await repository.acquireRunLock(projectId, locale)
  if (!token) throw new ApiError(409, "Tài liệu đang được dịch ở một lượt khác — đợi lượt đó xong rồi chạy lại.", TRANSLATION_RUNNING)
  try {
    return await runBatches(projectId, userId, locale, source, spine, options, executor)
  } finally {
    await repository
      .releaseRunLock(projectId, locale, token)
      .catch((err) => console.warn(`[Translation] Không nhả được khoá dịch của project ${projectId}:`, err))
  }
}

const runBatches = async (
  projectId: string,
  userId: string,
  locale: UserLocale,
  source: UserLocale,
  spine: Spine,
  options: { max_batches?: number },
  executor: TranslateDocumentExecutor
): Promise<TranslationRunResult> => {
  // Tra SAU khi chiếm khoá: lượt trước vừa xong thì phần nó đã dịch không còn "thiếu"
  const resolved = await resolveTranslations(projectId, locale, translationUnits(spine))
  if (resolved.missing === 0) return { translated: 0, remaining: 0, credits_used: 0 }

  await seedGlossary(projectId, locale, spine, resolved.map)
  const glossary = await repository.loadGlossary(projectId, locale)
  const batches = splitBatches(uniqueBatchItems(resolved.missingUnits)).slice(0, options.max_batches ?? DEFAULT_MAX_BATCHES)

  const translatedHashes = new Set<string>()
  let creditsUsed = 0
  let batchesDone = 0
  let firstParseError: unknown = null
  for (const batch of batches) {
    let result: AiActionResult<TranslateDocumentOutput>
    try {
      result = await executor(
        {
          promptVariables: {
            source_language: LANGUAGE_NAMES[source],
            target_language: LANGUAGE_NAMES[locale],
            glossary: formatGlossary(glossaryFor(glossary, batch.map((item) => item.text))),
            items: JSON.stringify(batch.map(({ key, text }) => ({ key, text })), null, 2)
          }
        },
        projectId,
        userId
      )
    } catch (err) {
      if (isParseError(err)) {
        // Lô này không ghi gì, credit đã nhả — thử các lô sau
        console.warn(`[Translation] Bỏ qua một lô parse lỗi của project ${projectId}:`, err)
        firstParseError ??= err
        continue
      }
      if (batchesDone === 0) throw err
      console.warn(`[Translation] Dừng dịch theo lô của project ${projectId} sau ${batchesDone} lô:`, err)
      break
    }
    batchesDone++
    creditsUsed += result.cost ?? 0

    const accepted = acceptBatchItems(batch, result.data.items)
    try {
      await repository.saveTranslations(projectId, locale, source, accepted, "machine")
    } catch (err) {
      // Lô đã trừ credit: dừng và trả đúng phần đã có thay vì 500 làm mất `credits_used`
      console.error(`[Translation] Không lưu được bản dịch của project ${projectId}, dừng sau ${batchesDone} lô:`, err)
      break
    }
    for (const unit of accepted) translatedHashes.add(unit.sourceHash)
    // Tên vừa dịch thành thuật ngữ cho các lô sau (không đè thuật ngữ đã có) — lỗi thì bỏ qua, bản dịch đã lưu
    try {
      const learned = await learnGlossary(projectId, locale, accepted)
      for (const entry of learned) if (!glossary.some((g) => g.term === entry.term)) glossary.push(entry)
    } catch (err) {
      console.warn(`[Translation] Không học được glossary của project ${projectId}:`, err)
    }
    if (accepted.length === 0) {
      // Trả credit mà không tiến ⇒ dừng, không đốt thêm lô nào
      console.warn(`[Translation] Một lô của project ${projectId} không có bản dịch hợp lệ nào — dừng`)
      break
    }
  }
  if (batchesDone === 0 && firstParseError) throw firstParseError

  const translated = resolved.missingUnits.filter((unit) => translatedHashes.has(hashSource(unit.value))).length
  return { translated, remaining: resolved.missing - translated, credits_used: creditsUsed }
}
