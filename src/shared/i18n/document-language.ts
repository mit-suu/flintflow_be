/**
 * Ngôn ngữ tài liệu trong prompt (FLF-265 D16): lượt AI ghi Spine trả kèm chữ theo ngôn ngữ tài liệu của dự án.
 *
 * Khi `documentLanguage ≠ ngôn ngữ gốc` (mode 2: gốc luôn `en`) và ActionType ra op, `buildPrompt` nối khối
 * "## Document language" vào cuối prompt: `ops` vẫn tiếng Anh như cũ (draft-to-ops luật 6), đầu ra thêm
 * `localized: [{ path, value }]` cạnh `ops` — cùng `path` với op, cùng khung `value`, chỉ chữ tự nhiên được dịch.
 * Ghi Spine xong, `translation/capture.service.ts` tách đơn vị từ cặp (value Anh, value dịch) và lưu bản `author`.
 *
 * Dự án `documentLanguage == ngôn ngữ gốc` (mọi dự án `en`, mode 1) ⇒ không có khối ⇒ prompt y như trước FLF-265.
 */
import { ActionType } from "../ai/ai-action.types.js"
import { isUserLocale, type UserLocale } from "./locale.js"

/** ActionType ra op (`opTransaction`, `discoveryStep`, `changeInstruction`) — chỉ chúng nhận khối. */
export const LOCALIZED_ACTION_TYPES: ReadonlySet<string> = new Set<string>([
  ActionType.DRAFT,
  ActionType.REGENERATE,
  ActionType.REVISION,
  ActionType.RECONCILE,
  ActionType.GLOSSARY_SCAN,
  ActionType.DISCOVERY_STEP,
  ActionType.CHANGE_INSTRUCTION
])

/**
 * Bật khối khi: ActionType ra op, `documentLanguage` hợp lệ và khác ngôn ngữ gốc. `sourceLanguage` thiếu / lạ ⇒ `en`
 * (mode 2). Input đi từ `POST /ai-actions` nguyên văn của client ⇒ giá trị lạ coi như không có.
 */
export const shouldLocalize = (actionType: string, documentLanguage: unknown, sourceLanguage: unknown): documentLanguage is UserLocale =>
  LOCALIZED_ACTION_TYPES.has(actionType) && isUserLocale(documentLanguage) && documentLanguage !== (isUserLocale(sourceLanguage) ? sourceLanguage : "en")

/**
 * Khoá `input` chỉ server được đặt (`documentLanguageInput`): bật khối là nới trần token và thêm một lượt gọi dự phòng mà
 * giá credit không đổi ⇒ client không được tự bật.
 */
export const DOCUMENT_LANGUAGE_INPUT_KEYS = ["documentLanguage", "sourceLanguage", "documentGlossary"] as const

/** `input` client gửi (`POST /ai-actions/execute`, `/retry/:logId`) bỏ các khoá ngôn ngữ tài liệu; không phải object ⇒ giữ nguyên. */
export const withoutDocumentLanguage = <T>(input: T): T => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input
  const rest: Record<string, unknown> = { ...(input as Record<string, unknown>) }
  for (const key of DOCUMENT_LANGUAGE_INPUT_KEYS) delete rest[key]
  return rest as T
}

/** Một thuật ngữ glossary dịch của dự án (`TranslationGlossary`). */
export interface DocumentGlossaryEntry {
  term: string
  translation: string
}

/** Trần số thuật ngữ trong khối — prompt chỉ cần những tên có mặt trong lượt này. */
export const MAX_DIRECTIVE_TERMS = 40
/** Trần độ dài một thuật ngữ / bản dịch — dài hơn là câu, không phải tên. */
const MAX_TERM_CHARS = 80

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Một dòng, không ký tự điều khiển markdown (`` ` ``) — glossary là dữ liệu dự án, không được phá khung prompt. */
export const oneLine = (value: unknown): string => (typeof value === "string" ? value.replace(/[\r\n\t`]+/g, " ").replace(/\s+/g, " ").trim() : "")

/**
 * Thuật ngữ có mặt trong `text` (không phân biệt hoa thường, trọn từ), theo thứ tự glossary, tối đa `limit`. Bỏ dòng hỏng
 * (không phải chuỗi, rỗng, quá dài). Dùng chung với dịch theo lô (`glossaryFor`).
 */
export const termsInText = <T extends DocumentGlossaryEntry>(entries: readonly T[], text: string, limit = Number.POSITIVE_INFINITY): T[] => {
  const out: T[] = []
  for (const entry of entries) {
    if (out.length >= limit) break
    const term = oneLine(entry?.term)
    const translation = oneLine(entry?.translation)
    if (!term || !translation || term.length > MAX_TERM_CHARS || translation.length > MAX_TERM_CHARS) continue
    if (new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(term)}(?=$|[^\\p{L}\\p{N}])`, "iu").test(text)) out.push(entry)
  }
  return out
}

const LANGUAGE_NAMES: Readonly<Record<UserLocale, string>> = { vi: "Vietnamese (tiếng Việt)", en: "English" }

/** Luật riêng theo ngôn ngữ đích (BR-06: shall/should/may). */
const LANGUAGE_RULES: Readonly<Record<UserLocale, string[]>> = {
  vi: ['- Modal verbs: "shall" ⇒ "phải", "should" ⇒ "nên", "may" ⇒ "có thể".'],
  en: []
}

/**
 * Khối nối vào CUỐI prompt (sau "Reply language" nếu có). Chữ cố định dựng từ enum; glossary là dữ liệu dự án đã lọc
 * (`termsInText`) và ép một dòng. Tránh các từ mock provider dò ("summarize", "extract", "Tóm tắt", "Trích xuất").
 */
export const documentLanguageDirective = (language: UserLocale, glossary: readonly DocumentGlossaryEntry[] = []): string => {
  const name = LANGUAGE_NAMES[language]
  const terms = glossary.slice(0, MAX_DIRECTIVE_TERMS).flatMap((entry) => {
    const term = oneLine(entry.term)
    const translation = oneLine(entry.translation)
    return term && translation ? [`  - ${term} → ${translation}`] : []
  })
  return [
    "## Document language",
    "",
    `The project's document language is **${name}**. The SRS is shown and exported in ${name}, but the document data`,
    "stays as the rules above say: every op is unchanged — English text, ids, codes and enum values exactly as before.",
    "",
    `Next to \`ops\`, add \`"localized": [{ "path": "...", "value": ... }]\` to the JSON you return. For every \`set\` / \`add\``,
    "op whose value contains natural-language text that renders into the SRS, write one entry with the SAME `path` as",
    `that op and a \`value\` with the same structure: same keys for the text fields, same \`id\`s, same array lengths and`,
    `order — only the natural-language text is written in ${name}. Always keep the \`id\` of every element in \`value\`.`,
    "Other fields without natural-language text (id lists, enum values, numbers, booleans) may be left out of `value`.",
    `- When the user wrote that sentence in ${name}, keep the user's wording almost verbatim instead of translating your`,
    "  English back.",
    "- Never change ids, codes (UC-01, FN010, A03), numbers, units, enum values, paths or keys. Keep technical terms such",
    "  as Use Case, Actor, NFR in English.",
    ...LANGUAGE_RULES[language],
    "- No entry for `remove` / `renumber` ops or for values without natural-language text. No `ops` ⇒ no `localized`.",
    ...(terms.length > 0 ? ["- Use these translations for the terms that appear in this turn:", ...terms] : [])
  ].join("\n")
}
