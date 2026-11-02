/**
 * Heading bao của mẫu bắt buộc (FLF-278): heading riêng của khách (`custom:*`, có tiêu đề) mà heading thật kế tiếp sâu hơn —
 * vd "2 Overall Description" chỉ để chứa 2.1, 2.2… Không có chữ thật thì nó không phải "mục còn trống": không xếp "Sẽ soạn"
 * ở I-5, không cờ `template_section_empty`, không "Nhờ AI soạn", không vào thống kê mục thiếu. Có chữ thật thì vẫn là mục bình
 * thường. Phần nối (mục riêng tiêu đề rỗng, FLF-184) không phải heading ⇒ bỏ qua khi tìm heading kế tiếp.
 */
import type { LayoutEntry } from "./template-profile.model.js"

const isContinuation = (l: Pick<LayoutEntry, "section_id" | "heading_text">): boolean =>
  l.section_id.startsWith("custom:") && !l.heading_text.trim()

export const templateWrapperIds = (layout: readonly LayoutEntry[]): Set<string> => {
  const headings = [...layout].sort((a, b) => a.order - b.order).filter((l) => !isContinuation(l))
  const out = new Set<string>()
  headings.forEach((entry, i) => {
    const next = headings[i + 1]
    if (entry.section_id.startsWith("custom:") && next && next.level > entry.level) out.add(entry.section_id)
  })
  return out
}
