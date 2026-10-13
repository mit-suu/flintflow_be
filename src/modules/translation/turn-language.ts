/**
 * turn-language.ts
 * ─────────────────────────────────────────────────────────────────
 * Ngôn ngữ tài liệu của MỘT lượt ghi Spine (FLF-265 D16) — đọc một lần ở cửa vào lượt (`runStep`, `gate`, lượt sửa qua
 * chat, hoà giải) rồi đi theo mọi lượt gọi model của lượt đó.
 *
 * - `documentLanguageOf == sourceLanguageOf` (mọi dự án `en`, mode 1) ⇒ `null` ⇒ không có khối "Document language",
 *   prompt y như trước FLF-265.
 * - Khác ⇒ `{ locale, source, glossary }`; `glossary` = seed hiện tại của Spine (`glossary[].term_native`, đọc thẳng —
 *   dự án tạo mới bằng `vi` gần như không chạy `/run` nên chưa có seed đã lưu) gộp glossary dịch đã lưu
 *   (`TranslationGlossary`); `buildPrompt` chỉ giữ thuật ngữ có mặt trong prompt.
 * - Chưa nối DB (unit test) / đọc lỗi ⇒ `null`: thiếu bản dịch kèm thì câu đó thành "thiếu", lượt ghi Spine không hỏng.
 */

import mongoose from "mongoose"
import type { AiActionInput } from "../../shared/ai/ai-action.types.js"
import type { UserLocale } from "../../shared/i18n/locale.js"
import { Project } from "../project/project.model.js"
import { Spine as SpineModel } from "../spine/spine.model.js"
import { mergeGlossary, seedEntriesOf } from "./glossary.service.js"
import * as repository from "./translation.repository.js"
import type { GlossaryEntry } from "./translation.repository.js"
import { projectLanguages } from "./translation.service.js"

export interface TurnDocumentLanguage {
  /** Ngôn ngữ tài liệu (đích của `localized`). */
  locale: UserLocale
  /** Ngôn ngữ chữ trong Spine. */
  source: UserLocale
  glossary: GlossaryEntry[]
}

/** Đủ để lưu bản dịch (`captureForTurn`) — preview giữ đến lượt áp chỉ cần cặp này, không mang glossary theo. */
export type TurnLanguagePair = Pick<TurnDocumentLanguage, "locale" | "source">

export const languagePairOf = (language: TurnLanguagePair | null | undefined): TurnLanguagePair | null =>
  language ? { locale: language.locale, source: language.source } : null

/** Seed hiện tại của Spine (chỉ đọc `glossary`). Đọc lỗi ⇒ `[]`: vẫn còn glossary đã lưu, lượt không hỏng. */
const spineSeeds = async (projectId: string, locale: UserLocale): Promise<GlossaryEntry[]> => {
  if (locale === "en") return []
  try {
    const doc = await SpineModel.findOne({ projectId }, { glossary: 1 }).lean<{ glossary?: { term: string; term_native?: string }[] }>()
    return seedEntriesOf(locale, doc?.glossary)
  } catch (err) {
    console.warn("[documentLanguageForTurn] Không đọc được glossary của Spine — chỉ dùng glossary đã lưu:", err)
    return []
  }
}

export const documentLanguageForTurn = async (projectId: string): Promise<TurnDocumentLanguage | null> => {
  if (mongoose.connection.readyState !== 1 || !mongoose.isValidObjectId(projectId)) return null
  try {
    const project = await Project.findById(projectId, { mode: 1, documentLanguage: 1 }).lean()
    if (!project) return null
    const { locale, source } = await projectLanguages(projectId, project)
    if (locale === source) return null
    const [seeds, stored] = await Promise.all([spineSeeds(projectId, locale), repository.loadGlossary(projectId, locale)])
    return { locale, source, glossary: mergeGlossary(seeds, stored) }
  } catch (err) {
    console.warn("[documentLanguageForTurn] Không đọc được ngôn ngữ tài liệu — lượt này không kèm bản dịch:", err)
    return null
  }
}

/**
 * Phần `input` của `executeAiAction` cho khối "Document language". `AiActionInput` (đóng băng) nhận qua chữ ký chỉ mục —
 * cạnh `replyLanguage`. Không có ngôn ngữ ⇒ `{}` (input y như cũ).
 */
export const documentLanguageInput = (language: TurnDocumentLanguage | null | undefined): Partial<AiActionInput> =>
  language ? { documentLanguage: language.locale, sourceLanguage: language.source, documentGlossary: language.glossary } : {}
