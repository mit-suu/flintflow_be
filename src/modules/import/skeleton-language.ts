/**
 * FLF-456 — Ngôn ngữ tài liệu khi file chỉ còn khung (business-flow §3.1.2 "Ngôn ngữ tài liệu", nguyên tắc 7).
 *
 * File **chỉ còn khung** = không mục nào giữ nội dung (mọi mục có chữ đã Bỏ chữ). Chỉ khi đó người dùng được chọn ngôn ngữ tài
 * liệu (EN / VI); chọn khác ngôn ngữ file thì phần khung được dịch một lần lúc bấm Bắt đầu: heading, tiêu đề cột bảng, chữ hướng
 * dẫn thật. Còn mục giữ nội dung ⇒ không có lựa chọn, ngôn ngữ theo file để không viết lại chữ của khách.
 *
 * File này chỉ có phần thuần (quyết định + gom đơn vị dịch + ghi lại vào DOM); lượt gọi AI ở `skeleton-translate.ts`.
 */
import { isInstructionText } from "../../shared/utils/instruction-text.js"
import { toUserLocale, type UserLocale } from "../../shared/i18n/locale.js"
import { NS } from "../docx-ooxml/xml.js"
import { setParagraphText, type DropBlock } from "./drop-text.js"
import { splitHeadingNumber } from "./text-similarity.js"

const HAS_LETTER = /\p{L}/u

export interface SkeletonLanguageView {
  /** Ô EN / VI chỉ hiện khi file chỉ còn khung. */
  visible: boolean
  /** Ngôn ngữ của file. */
  file: UserLocale
  /** Ngôn ngữ đang chọn (mặc định = ngôn ngữ file; ô ẩn ⇒ luôn = ngôn ngữ file). */
  selected: UserLocale
}

/** Ngôn ngữ của file (`TemplateProfile.language`); lạ / thiếu ⇒ `en`. */
export const fileLanguageOf = (profile: { language?: string | null }): UserLocale => toUserLocale(profile.language) ?? "en"

/** Chỉ còn khung: mọi mục có chữ đã Bỏ chữ (file không có mục nào có chữ cũng tính). */
export const isSkeletonOnly = (regions: readonly { dropped: boolean }[]): boolean => regions.every((r) => r.dropped)

export const skeletonLanguageView = (
  profile: { language?: string | null; skeleton_language?: string | null },
  regions: readonly { dropped: boolean }[]
): SkeletonLanguageView => {
  const file = fileLanguageOf(profile)
  const visible = isSkeletonOnly(regions)
  return { visible, file, selected: visible ? (toUserLocale(profile.skeleton_language) ?? file) : file }
}

/** Ngôn ngữ cần dịch khung sang; `null` ⇒ không dịch (ô ẩn, hoặc chọn đúng ngôn ngữ file). */
export const skeletonTranslationTarget = (
  profile: { language?: string | null; skeleton_language?: string | null },
  regions: readonly { dropped: boolean }[]
): UserLocale | null => {
  const view = skeletonLanguageView(profile, regions)
  return view.visible && view.selected !== view.file ? view.selected : null
}

export interface SkeletonUnit {
  key: string
  text: string
  /** Ghi bản dịch vào DOM của file (chỉ có khi khối mang `element`). */
  apply?: (translated: string) => void
}

type SkeletonBlock = DropBlock & { element?: Element }

const W = NS.w

const kids = (el: Element, local: string): Element[] =>
  Array.from(el.childNodes).filter((n): n is Element => n.nodeType === 1 && (n as Element).namespaceURI === W && (n as Element).localName === local)

const paragraphText = (p: Element): string =>
  Array.from(p.getElementsByTagNameNS(W, "t"))
    .map((t) => t.textContent ?? "")
    .join("")

/**
 * Hàm thuần: chữ khung đáng dịch của các khối còn lại sau Bỏ chữ — heading (không kể số mục), hàng tiêu đề của bảng, chữ hướng
 * dẫn thật (cả đoạn trong ngoặc). Khối có `element` thì đơn vị mang `apply` ghi lại vào đúng đoạn / ô.
 */
export const skeletonUnits = (blocks: readonly SkeletonBlock[]): SkeletonUnit[] => {
  const units: SkeletonUnit[] = []
  const add = (text: string, apply: ((t: string) => void) | undefined) => units.push({ key: `u${units.length + 1}`, text, ...(apply ? { apply } : {}) })
  for (const b of blocks) {
    const el = b.element
    if (b.kind === "heading") {
      const { title } = splitHeadingNumber(b.text)
      if (!HAS_LETTER.test(title)) continue
      const prefix = b.text.slice(0, Math.max(0, b.text.lastIndexOf(title)))
      add(title, el && ((t) => setParagraphText(el, `${prefix}${t}`)))
    } else if ((b.kind === "paragraph" || b.kind === "list_item") && isInstructionText(b.text)) {
      const raw = b.text.trim()
      const inner = raw.slice(1, -1).trim()
      if (!HAS_LETTER.test(inner)) continue
      add(inner, el && ((t) => setParagraphText(el, `${raw[0]}${t}${raw[raw.length - 1]}`)))
    } else if (b.kind === "table" && b.rows?.[0]) {
      const header = b.rows[0]
      const cells = el && el.localName === "tbl" ? kids(kids(el, "tr")[0] ?? el, "tc") : []
      header.forEach((cell, i) => {
        const text = cell.trim()
        if (!HAS_LETTER.test(text) || isInstructionText(text)) return
        const p = cells.length === header.length ? kids(cells[i], "p").find((para) => paragraphText(para).trim() === text) : undefined
        add(text, p && ((t) => setParagraphText(p, t)))
      })
    }
  }
  return units
}
