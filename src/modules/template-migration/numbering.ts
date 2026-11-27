/**
 * Đánh số lại heading đến từ tài liệu cũ trong layout của mẫu mới — thuần, không file.
 *
 * Mẫu đánh số bằng chữ trong heading (jam01: "3.2 Chức năng"): heading cũ có số (nhóm chức năng "3.2 Tài khoản…", phần gộp "2.2.2 Đặc tả
 * use case", mục riêng "5.9 Ghi chú") nhận số = số heading cha + "." + thứ tự trong các anh em có số — heading của mẫu giữ nguyên chữ và
 * chiếm chỗ của nó trong thứ tự (sau "3.3.5" là "3.3.6"). Heading cũ không có số ("Mục tiêu", "Kích hoạt chức năng") giữ nguyên, không
 * chiếm số — trừ khi nó là anh em của các heading có số (mục riêng / phần gộp đặt làm con cuối của "3.1" sau 3.1.1…3.1.3 ⇒ "3.1.4"),
 * để không thành heading duy nhất không số giữa các anh em. Mẫu đánh số tự động (Word tự đánh theo style) ⇒ bỏ số chữ cũ để không in hai lần. Mẫu không đánh số ⇒ giữ nguyên.
 */
import { splitHeadingNumber } from "../import/text-similarity.js"

export type HeadingNumbering = "text" | "auto" | "none"

export interface NumberedEntry {
  heading_text: string
  level: number
  /** `target` = heading của mẫu đích (giữ chữ); còn lại là heading đến từ tài liệu cũ. */
  kind: string
}

/** Kiểu đánh số của mẫu suy từ chữ heading: ≥ một nửa heading có số gõ tay ⇒ `text`. */
export const numberingOfHeadings = (headings: readonly { heading_text: string }[]): HeadingNumbering => {
  const shown = headings.filter((h) => h.heading_text.trim())
  if (!shown.length) return "none"
  return shown.filter((h) => splitHeadingNumber(h.heading_text).number !== null).length * 2 >= shown.length ? "text" : "none"
}

const isArabic = (n: string | null): n is string => !!n && /^\d+(\.\d+)*$/.test(n)

/**
 * Chữ heading mới cho từng mục (cùng thứ tự `entries`). Trả kèm bảng chữ cũ ⇒ chữ mới của heading đã đổi số (để sửa tham chiếu chéo
 * nguyên ô / nguyên đoạn); chữ cũ trùng nhau giữa nhiều heading thì không đưa vào bảng.
 */
export const renumberEntries = (entries: readonly NumberedEntry[], style: HeadingNumbering): { texts: string[]; changed: Map<string, string>; numbered: Map<string, string> } => {
  const texts = entries.map((e) => e.heading_text)
  const changed = new Map<string, string>()
  /** Heading cũ không số vừa nhận số (chỉ để sửa chữ heading, không sửa ô / đoạn trùng chữ — tên trần dễ trùng chữ thường). */
  const numbered = new Map<string, string>()
  if (style === "none") return { texts, changed, numbered }
  const dup = new Set<string>()
  const record = (from: string, to: string): void => {
    if (from === to) return
    if (changed.has(from) && changed.get(from) !== to) dup.add(from)
    changed.set(from, to)
  }

  if (style === "auto") {
    entries.forEach((e, i) => {
      if (e.kind === "target" || !e.heading_text.trim()) return
      const { number, title } = splitHeadingNumber(e.heading_text)
      if (number === null) return
      texts[i] = title
      record(e.heading_text.trim(), title)
    })
  } else {
    /** Heading cha đang mở: số (có thể không có) + số thứ tự con có số lớn nhất đã dùng. */
    const stack: { level: number; number: string | null; last: number }[] = []
    entries.forEach((e, i) => {
      if (!e.heading_text.trim()) return
      while (stack.length && stack[stack.length - 1].level >= e.level) stack.pop()
      const parent = stack[stack.length - 1]
      const { number, title } = splitHeadingNumber(e.heading_text)
      let own: string | null = isArabic(number) ? number : null
      if (e.kind === "target") {
        // Heading mẫu chiếm chỗ của nó: "3.3.5" dưới "3.3" ⇒ con có số tiếp theo của "3.3" là 6
        if (own && parent?.number && own.startsWith(`${parent.number}.`)) parent.last = Math.max(parent.last, Number(own.slice(parent.number.length + 1).split(".")[0]) || 0)
      } else if (own !== null && parent?.number) {
        parent.last += 1
        own = `${parent.number}.${parent.last}`
        texts[i] = `${own} ${title}`
        record(e.heading_text.trim(), texts[i])
      } else if (own === null && number === null && parent?.number && parent.last > 0 && (e.kind === "custom" || e.kind === "moved")) {
        parent.last += 1
        own = `${parent.number}.${parent.last}`
        texts[i] = `${own} ${title}`
        numbered.set(e.heading_text.trim(), texts[i])
      }
      stack.push({ level: e.level, number: own, last: 0 })
    })
  }
  for (const d of dup) changed.delete(d)
  return { texts, changed, numbered }
}
