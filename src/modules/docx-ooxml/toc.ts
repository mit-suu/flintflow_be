/**
 * Mục lục (TOC) là **tín hiệu cấu trúc heading**, không bao giờ là nội dung (FLF-343, I-3):
 * - đoạn mục lục của Word (style `toc N`, nằm trong field / content control TOC) và dòng mục lục gõ tay
 *   (`1.1 Purpose ........ 5`, `Introduction<tab>3`) không thành block;
 * - mỗi dòng đọc ra `{ number, title, level }`; đoạn thân bài có tiêu đề trùng một dòng mục lục ⇒ heading (cấp theo mục lục).
 * Hàm thuần trên chữ — `blocks.ts` lo phần XML.
 */

export interface TocEntry {
  /** Số mục gõ trong dòng (`3.2.1`); không có ⇒ `null`. */
  number: string | null
  title: string
  /** Cấp: style `toc N` ⇒ N; không có style ⇒ độ sâu số mục; không có cả hai ⇒ 1. */
  level: number
}

/** Số mục đầu dòng: `3.2.1`, `3.2.1.`, `I.`, `IV`. */
const LEADING_NUMBER = /^((?:\d{1,2})(?:\.\d{1,2}){0,5}|[IVX]{1,5})\.?\s+/
/** Dòng mục lục gõ tay: tiêu đề + chuỗi dẫn (dấu chấm, `…`, `·`, `_`, tab) + số trang ở cuối. */
const HAND_TOC_LINE = /^(\S.{1,150}?)\s*(?:[.·_]{3,}|…+|\t+)[\s.…·_]*(\d{1,4})\s*$/
/** Tiêu đề của trang mục lục. */
export const TOC_TITLE = /^(table of contents|contents|mục lục|muc luc)\s*:?$/i

/** Chuẩn hoá tiêu đề để so: bỏ số mục, dấu, chữ thường, gộp khoảng trắng, bỏ dấu câu cuối. */
export const tocKey = (text: string): string =>
  text
    .replace(LEADING_NUMBER, "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[\s ]+/g, " ")
    .replace(/[.:;,\s]+$/, "")
    .trim()

const splitNumber = (text: string): { number: string | null; title: string } => {
  const m = LEADING_NUMBER.exec(text.trim())
  return m ? { number: m[1], title: text.trim().slice(m[0].length).trim() } : { number: null, title: text.trim() }
}

const levelOf = (number: string | null, styleLevel: number | null): number =>
  styleLevel ?? (number && /^\d/.test(number) ? number.split(".").length : 1)

/** Dòng gõ tay có dạng mục lục (tiêu đề + dẫn + số trang). */
export const isHandTocLine = (text: string): boolean => {
  const t = text.trim()
  const m = HAND_TOC_LINE.exec(t)
  return !!m && /\p{L}/u.test(m[1]) && !/[.;:!?]$/.test(m[1].replace(/[.…·_\s]+$/, ""))
}

/**
 * Một dòng mục lục (của Word hoặc gõ tay) ⇒ mục. Bỏ số trang + chuỗi dẫn ở cuối; dòng không có chữ ⇒ `null`.
 * `styleLevel`: cấp theo style `toc N` (nếu có).
 */
export const parseTocLine = (text: string, styleLevel: number | null = null): TocEntry | null => {
  const t = text.replace(/\s+$/, "")
  const hand = HAND_TOC_LINE.exec(t.trim())
  const body = (hand ? hand[1] : t.replace(/\t+\s*\d{1,4}\s*$/, "")).replace(/[\s.…·_]+$/, "").trim()
  if (!body || !/\p{L}/u.test(body)) return null
  const { number, title } = splitNumber(body)
  if (!title) return null
  return { number, title, level: levelOf(number, styleLevel) }
}

/**
 * Chỉ mục mục lục: tra đoạn thân bài theo tiêu đề (kèm số mục nếu cả hai cùng có). Một dòng mục lục nhận nhiều lần — tiêu
 * đề lặp ("Overview" dưới nhiều tính năng) thì mục lục cũng lặp.
 */
export class TocIndex {
  private readonly byKey = new Map<string, TocEntry[]>()

  constructor(entries: readonly TocEntry[] = []) {
    for (const e of entries) this.add(e)
  }

  add(e: TocEntry): void {
    const key = tocKey(e.title)
    if (!key) return
    this.byKey.set(key, [...(this.byKey.get(key) ?? []), e])
  }

  get size(): number {
    return [...this.byKey.values()].reduce((n, list) => n + list.length, 0)
  }

  /**
   * Mục khớp đoạn `text`, mỗi mục dùng một lần theo thứ tự. Đoạn gõ số ⇒ phải có mục cùng tiêu đề **và cùng số**. Đoạn không
   * số chỉ khớp khi người gọi cho phép (`unnumbered` — đoạn đứng sau mục lục và có tín hiệu định dạng): một câu thân bài trùng
   * tiêu đề mục lục ("Overview") không tự thành heading.
   */
  find(text: string, opts: { unnumbered?: boolean } = {}): TocEntry | null {
    const { number } = splitNumber(text)
    const list = this.byKey.get(tocKey(text))
    if (!list?.length) return null
    const hit = number ? list.find((e) => e.number === number && !this.used.has(e)) : opts.unnumbered ? list.find((e) => !this.used.has(e)) : undefined
    if (!hit) return null
    this.used.add(hit)
    return hit
  }

  private readonly used = new Set<TocEntry>()
}
