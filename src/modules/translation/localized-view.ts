/**
 * localized-view.ts
 * ─────────────────────────────────────────────────────────────────
 * Spine đã dịch cho CHỮ HIỂN THỊ của người dùng ngoài tài liệu (FLF-479 #6): bảng so sánh ở cổng S-1.1 và bản xem trước
 * Sửa tài liệu. Dùng đúng lớp bản dịch của màn Tài liệu (`localized-spine.ts`, tra theo hash chữ gốc) nhưng KHÔNG gọi
 * AI: đơn vị chưa có bản dịch giữ chữ gốc; lỗi tra cứu ⇒ trả Spine gốc. Kết quả chỉ để HIỆN, không đưa vào op-engine,
 * kiểm tra, prompt hay hash (xem `LocalizedSpine`).
 */

import type { Spine } from "../spine/spine.types.js"
import { localizeSpine, renderView } from "../render/localized-spine.js"
import { translationUnits, type TranslationUnit, type UnitValue } from "./translation-units.js"
import { resolveTranslations } from "./translation.service.js"
import type { TurnLanguagePair } from "./turn-language.js"

export type TranslationLookup = (projectId: string, locale: TurnLanguagePair["locale"], units: TranslationUnit[]) => Promise<{ map: Map<string, UnitValue> }>

/**
 * Bản xem đã dịch của `spine`. `language` rỗng hoặc cùng ngôn ngữ gốc (dự án tiếng Anh) ⇒ chính `spine`; chưa có bản dịch
 * nào ⇒ chính `spine`; có lỗi ⇒ chính `spine`.
 */
export const translatedViewOf = async (
  projectId: string,
  spine: Spine,
  language: TurnLanguagePair | null | undefined,
  lookup: TranslationLookup = resolveTranslations
): Promise<Spine> => {
  if (!language || language.locale === language.source) return spine
  try {
    const units = translationUnits(spine)
    const { map } = await lookup(projectId, language.locale, units)
    if (map.size === 0) return spine
    return renderView(localizeSpine(spine, units, map))
  } catch (err) {
    console.warn("[translatedViewOf] Không tra được bản dịch - hiện chữ gốc:", err)
    return spine
  }
}
