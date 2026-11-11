/**
 * Ngôn ngữ chữ của tài liệu cho change request (QLHS 11/11 bug #17: CR tiếng Việt cho tài liệu tiếng Việt mà C-4 viết bước
 * mới "After GVCN saves attendance…" và nhãn luồng "Absence Notification" bằng tiếng Anh).
 * - `crDocumentLanguage`: ngôn ngữ chữ trong Spine (chữ op sẽ ghi vào) — khai báo `vi` của dự án (`sourceLanguageOf`), còn
 *   lại đoán từ chính chữ của Spine (`TemplateProfile.language` mặc định `en` nên không tin trước chữ thật).
 * - `documentLanguageText`: dòng "Document language" của prompt C-4.
 * - `foreignTexts`: luật tất định của C-5 — chữ mới viết khác ngôn ngữ tài liệu ⇒ vi phạm `wrong_language`, AI làm lại.
 */

import type { UserLocale } from "../../shared/i18n/locale.js"
import { detectMessageLanguage, hasVietnameseMarks, wordLanguageCounts } from "../../shared/i18n/reply-language.js"
import { TemplateProfile } from "../import/template-profile.model.js"
import { sourceLanguageOf } from "../project/document-language.js"
import { Project } from "../project/project.model.js"
import type { Spine } from "../spine/spine.types.js"
import { plainValues } from "./cr-context.js"

/** Lượng chữ của Spine đem đoán ngôn ngữ. */
const SAMPLE_CHARS = 4000

/** Đoán từ chữ mô tả của Spine (chức năng, use case, luật, NFR, tác nhân); không đủ tín hiệu ⇒ `null`. */
export const guessSpineLanguage = (spine: Pick<Spine, "functions" | "use_cases" | "business_rules" | "nfrs" | "actors">): UserLocale | null =>
  detectMessageLanguage(plainValues([spine.functions, spine.use_cases, spine.business_rules, spine.nfrs, spine.actors]).slice(0, SAMPLE_CHARS))

/** Khai báo `vi` (không bao giờ là giá trị mặc định) ⇒ tin ngay; còn lại (`en` có thể chỉ là mặc định) ⇒ chữ thật của Spine trước. */
export const crDocumentLanguage = async (projectId: string, spine: Parameters<typeof guessSpineLanguage>[0]): Promise<UserLocale> => {
  const project = await Project.findById(projectId, { mode: 1, converted_from: 1 }).lean()
  const profile = project?.mode === "import" ? await TemplateProfile.findOne({ projectId }, { language: 1 }).lean() : null
  const declared = project ? sourceLanguageOf(project, profile?.language) : null
  if (declared === "vi") return declared
  return guessSpineLanguage(spine) ?? declared ?? "en"
}

const LANGUAGE_NAME: Readonly<Record<UserLocale, string>> = { vi: "Vietnamese (tiếng Việt)", en: "English" }

/** Dòng ngữ cảnh C-4: ngôn ngữ mọi chữ mới / sửa trong `spine_ops` phải theo. */
export const documentLanguageText = (language: UserLocale): string =>
  `${LANGUAGE_NAME[language]}. Every new or changed text value in spine_ops (steps, descriptions, statements, names, labels such as flows_in / flows_out, table cells) and every reason, comment_text and assumption is written in ${LANGUAGE_NAME[language]}, with the wording and terms the existing elements and the glossary already use - even when the change request, the answers or the material are in another language. Names quoted from the document or the change request (screen names, statuses, codes, product names) keep their original form.`

// ─── C-5: chữ mới khác ngôn ngữ tài liệu ─────────────────────────

/** Đoạn ngắn hơn số từ này (nhãn "Email", "API Gateway") không phán ngôn ngữ. */
export const MIN_FOREIGN_WORDS = 4
/** Không có lấy một từ Việt mà dài từng này từ ⇒ câu văn, không phải tên riêng / nhãn giữ nguyên tiếng Anh. */
const MIN_PLAIN_FOREIGN_WORDS = 6

/** Phần giữ nguyên văn, không mang ngôn ngữ của câu: trích trong ngoặc kép, đường dẫn / mã có `/`. */
const QUOTED = [/"[^"\n]*"/g, /“[^”\n]*”/g, /\S*\/\S*/g]

const stringLeaves = (value: unknown, out: string[] = []): string[] => {
  if (typeof value === "string") out.push(value)
  else if (Array.isArray(value)) value.forEach((v) => stringLeaves(v, out))
  else if (value && typeof value === "object") Object.values(value).forEach((v) => stringLeaves(v, out))
  return out
}

/** Một chuỗi rõ ràng viết bằng ngôn ngữ khác `language` (đủ dài, đa số từ thuộc ngôn ngữ kia). */
export const isForeignText = (text: string, language: UserLocale): boolean => {
  const { words, vi, en } = wordLanguageCounts(QUOTED.reduce((acc, p) => acc.replace(p, " "), text))
  if (words < MIN_FOREIGN_WORDS) return false
  // Tài liệu tiếng Việt: câu tiếng Anh (từ tiếng Anh thông dụng nhiều hơn từ Việt), hoặc câu dài không có lấy một từ Việt
  if (language === "vi") return (en >= 2 && en > vi) || (vi === 0 && words >= MIN_PLAIN_FOREIGN_WORDS)
  return vi >= 2 && vi > en
}

/**
 * Chuỗi mới (có ở `after`, không có ở `before`) viết khác ngôn ngữ tài liệu. Chỉ phán khi chữ đang có của phần tử đúng ngôn
 * ngữ tài liệu (tiếng Việt: có dấu; tiếng Anh: không dấu) — phần tử vốn viết ngôn ngữ khác thì theo nó; phần tử / mục rỗng
 * thì theo ngôn ngữ tài liệu.
 */
export const foreignTexts = (language: UserLocale, before: unknown, after: unknown): string[] => {
  const old = stringLeaves(before)
  const existing = old.join("\n")
  if (existing.trim() && hasVietnameseMarks(existing) !== (language === "vi")) return []
  const seen = new Set(old.map((s) => s.trim()))
  return [...new Set(stringLeaves(after).map((s) => s.trim()))].filter((s) => s && !seen.has(s) && isForeignText(s, language))
}

const QUOTE_CHARS = 120

/** Câu cho người dùng (C-5 `wrong_language`) — không mã nội bộ; trích tối đa một đoạn. */
export const wrongLanguageMessage = (element: string, language: UserLocale, texts: readonly string[]): string => {
  const sample = texts[0].length > QUOTE_CHARS ? `${texts[0].slice(0, QUOTE_CHARS)}…` : texts[0]
  const [wrote, doc] = language === "vi" ? ["tiếng Anh", "tiếng Việt"] : ["tiếng Việt", "tiếng Anh"]
  const more = texts.length > 1 ? ` (và ${texts.length - 1} đoạn khác)` : ""
  return `Nội dung mới ở ${element} viết bằng ${wrote} trong khi tài liệu viết bằng ${doc}: “${sample}”${more} - viết lại bằng ${doc}, dùng đúng thuật ngữ của tài liệu`
}
