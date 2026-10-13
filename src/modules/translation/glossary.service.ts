/**
 * glossary.service.ts
 * ─────────────────────────────────────────────────────────────────
 * Glossary dịch tự động của dự án (FLF-265 D8) — không có UI, không sửa `Spine.glossary`.
 * - `seed`: `Spine.glossary[].term → term_native` (khi user đã cho thuật ngữ bản ngữ).
 * - `model`: tên actor / màn / entity / feature đã có bản dịch (lượt AI trả kèm hoặc dịch theo lô) — để lô sau và
 *   lượt ghi Spine sau dịch cùng một tên giống nhau.
 * Prompt chỉ nhận các thuật ngữ CÓ MẶT trong lô (`glossaryFor`), không nạp cả glossary.
 */

import type { Spine } from "../spine/spine.types.js"
import type { UserLocale } from "../../shared/i18n/locale.js"
import { MAX_DIRECTIVE_TERMS, oneLine, termsInText } from "../../shared/i18n/document-language.js"
import * as repository from "./translation.repository.js"
import type { GlossaryEntry } from "./translation.repository.js"
import { hashSource, translationUnits, type LocalizedUnit, type TranslationUnit, type UnitValue } from "./translation-units.js"

/** Tên dùng làm thuật ngữ: một chuỗi, nằm ở `name` của các nhóm này. */
const NAME_KEY = /^(actors|screens|entities|features)\[id=[^\]]+\]\.name$/

export const isNameUnit = (unit: Pick<TranslationUnit, "key">): boolean => NAME_KEY.test(unit.key)

/** Cặp (tên gốc, tên dịch) học được từ các đơn vị đã dịch. */
export const namesOf = (units: Pick<LocalizedUnit, "key" | "source" | "text">[]): GlossaryEntry[] =>
  units.flatMap((unit) =>
    isNameUnit(unit) && typeof unit.source === "string" && typeof unit.text === "string" && unit.text.trim()
      ? [{ term: unit.source.trim(), translation: unit.text.trim() }]
      : []
  )

/**
 * Lưu tên đã dịch thành thuật ngữ `model` — không bao giờ đè `seed`.
 * - `replace = false` (bản `machine` vừa dịch theo lô): chỉ chèn, không đè bản học trước.
 * - `replace = true`: tên lấy từ bản dịch đang thắng — bản `author` (lượt AI ghi Spine trả kèm, §2.7, thắng `machine`)
 *   hoặc bản đã lưu lúc gieo — ⇒ đè bản `model` cũ, để các lô sau dùng đúng chữ mà tài liệu đang hiện cho tên đó.
 */
export const learnGlossary = async (
  projectId: string,
  locale: UserLocale,
  units: Pick<LocalizedUnit, "key" | "source" | "text">[],
  replace = false
): Promise<GlossaryEntry[]> => {
  const learned = namesOf(units)
  await repository.upsertGlossary(projectId, locale, learned, "model", replace)
  return learned
}

/**
 * Thuật ngữ `seed` hiện tại của Spine: `term → term_native` (bỏ dòng thiếu / trùng term). `term_native` là chữ của user
 * (không phải tiếng Anh) ⇒ ngôn ngữ đích `en` không có seed. Dùng cho cả dịch theo lô (`seedGlossary`) và khối
 * "Document language" của lượt AI ghi Spine (`documentLanguageForTurn`) — dự án tạo mới bằng `vi` gần như không chạy
 * `/run`, nên khối đó đọc thẳng từ Spine thay vì chờ glossary đã lưu.
 */
export const seedEntriesOf = (locale: UserLocale, glossary: Pick<Spine["glossary"][number], "term" | "term_native">[] | null | undefined): GlossaryEntry[] =>
  locale === "en"
    ? []
    : (glossary ?? []).flatMap((g) => {
        const term = typeof g.term === "string" ? g.term.trim() : ""
        const native = typeof g.term_native === "string" ? g.term_native.trim() : ""
        return term && native && native !== term ? [{ term, translation: native }] : []
      })

/**
 * Gộp glossary để đưa vào prompt: seed hiện tại của Spine thắng bản đã lưu cùng term (seed đã lưu có thể cũ hơn
 * `term_native` vừa sửa), rồi các thuật ngữ đã lưu còn lại (`model`).
 */
export const mergeGlossary = (seeds: GlossaryEntry[], stored: GlossaryEntry[]): GlossaryEntry[] => {
  const seen = new Set(seeds.map((g) => g.term))
  return [...seeds, ...stored.filter((g) => !seen.has(g.term))]
}

/**
 * Gieo glossary trước khi dịch theo lô: `term_native` ⇒ `seed`; tên đã có bản dịch ⇒ `model` (đè bản `model` cũ). `translated` (key ⇒
 * chữ dịch) truyền vào khi người gọi đã tra rồi — không có thì tự tra các đơn vị tên bằng một truy vấn.
 * `term_native` là chữ của user (không phải tiếng Anh) ⇒ chỉ gieo khi ngôn ngữ đích khác `en`.
 */
export const seedGlossary = async (
  projectId: string,
  locale: UserLocale,
  spine: Pick<Spine, "glossary" | "actors" | "screens" | "entities" | "features">,
  translated?: Map<string, UnitValue>
): Promise<void> => {
  await repository.upsertGlossary(projectId, locale, seedEntriesOf(locale, spine.glossary), "seed")

  const { actors, screens, entities, features } = spine
  const names = translationUnits({ actors, screens, entities, features }).filter(isNameUnit)
  let known = translated
  if (!known) {
    const stored = await repository.findByHashes(projectId, locale, names.map((u) => hashSource(u.value)))
    known = new Map(names.flatMap((u) => {
      const hit = stored.get(hashSource(u.value))
      return hit ? [[u.key, hit.text] as const] : []
    }))
  }
  await learnGlossary(
    projectId,
    locale,
    names.flatMap((u) => {
      const text = known?.get(u.key)
      return text === undefined ? [] : [{ key: u.key, source: u.value, text }]
    }),
    // Bản đã lưu là bản đang thắng (`author` đã đè `machine` cùng hash) ⇒ glossary theo nó
    true
  )
}

const textOf = (value: UnitValue): string => (Array.isArray(value) ? value.join("\n") : value)

/**
 * Thuật ngữ có mặt trong lô (không phân biệt hoa thường, trọn từ) — cùng bộ lọc với khối "Document language" của lượt
 * AI ghi Spine (`termsInText`): bỏ dòng hỏng / quá dài (câu, không phải tên), tối đa `MAX_DIRECTIVE_TERMS` thuật ngữ.
 */
export const glossaryFor = (glossary: GlossaryEntry[], texts: UnitValue[]): GlossaryEntry[] =>
  termsInText(glossary, texts.map(textOf).join("\n"), MAX_DIRECTIVE_TERMS)

/**
 * Khối glossary trong prompt: một dòng một thuật ngữ, rỗng ⇒ `(none)`. `term_native` là chữ user nhập ⇒ ép một dòng,
 * bỏ backtick (`oneLine`) — không được phá khung prompt `translate_document`.
 */
export const formatGlossary = (entries: GlossaryEntry[]): string => {
  const lines = entries.flatMap(({ term, translation }) => {
    const t = oneLine(term)
    const tr = oneLine(translation)
    return t && tr ? [`- ${t} → ${tr}`] : []
  })
  return lines.length === 0 ? "(none)" : lines.join("\n")
}
