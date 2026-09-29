/**
 * Mục người yêu cầu **gọi tên** trong CR (2026-09-24): "tạo bảng cho phần 3.1.3 Screen Authorization", "phải ở 3.1.3
 * Phân quyền màn hình". Trước đây chỉ trông vào C-2 tự suy đích — model bỏ qua mục được nêu, CR ra 37 vị trí ở chỗ khác
 * và nội dung bị nhét vào NFR. Code nhận ra mục (theo tên + số mục), C-2 luôn cộng mục đó vào đích.
 *
 * Luật (thuần, test ở `section-mention.test.ts`):
 * - **Tên mục** (tiêu đề trong chính tài liệu, hoặc tên gọi FPT EN/VI ở `section-catalog`) chỉ tính khi đứng sau số mục
 *   hoặc sau chữ "mục / phần / section / chương" — để "sửa mô tả use case UC-02" không kéo cả mục Use Case Descriptions.
 * - Có tên ⇒ **chỉ tin tên**: số mục của tài liệu người dùng có thể lệch mẫu FPT (file này "3.1.3" là ERD, FPT 3.1.3 là
 *   Screen Authorization) — tên nói rõ ý hơn số.
 * - Không có tên ⇒ số mục đứng sau "mục / phần / section" (hoặc dạng tiêu đề `### 3.1.3`): tiêu đề tài liệu mang số đó
 *   trước, không có thì mục FPT cùng số.
 */

import { SECTION_CANDIDATES } from "../import/section-catalog.js"

export interface HeadingRef {
  text: string
  section_id: string | null
}

const norm = (s: string): string => s.normalize("NFC").toLowerCase().replace(/[“”"'`*#]/g, " ").replace(/\s+/g, " ").trim()
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const NUMBER = "\\d+(?:\\.\\d+){1,3}"
const MARKER = `(?:mục|phần|section|chương|§|${NUMBER})`
const LEADING_NUMBER = new RegExp(`^(${NUMBER})\\.?\\s+`)

const isContent = (id: string | null): id is string => !!id && !id.startsWith("group:") && id !== "unmapped"

/** `title` xuất hiện ngay sau một dấu hiệu gọi mục (số mục / "mục" / "phần"…), cách tối đa vài ký tự. */
const namedAfterMarker = (text: string, title: string): boolean =>
  title.length >= 6 && new RegExp(`${MARKER}\\s*[:\\-–]?\\s*${escape(title)}(?![\\p{L}\\p{N}])`, "iu").test(text)

export const mentionedSections = (rawText: string, headings: readonly HeadingRef[]): string[] => {
  const text = norm(rawText)
  const byName = new Set<string>()
  for (const h of headings) {
    if (!isContent(h.section_id)) continue
    const title = norm(h.text).replace(LEADING_NUMBER, "")
    if (namedAfterMarker(text, title)) byName.add(h.section_id)
  }
  for (const c of SECTION_CANDIDATES) {
    if (c.kind !== "fixed") continue
    if (c.titles.some((t) => namedAfterMarker(text, norm(t)))) byName.add(c.id)
  }
  if (byName.size) return [...byName]

  const byNumber = new Set<string>()
  for (const m of text.matchAll(new RegExp(`(?:mục|phần|section|chương|§)\\s*(${NUMBER})(?![\\d.]*\\d)`, "giu"))) {
    const num = m[1]
    const own = headings.find((h) => isContent(h.section_id) && LEADING_NUMBER.exec(norm(h.text))?.[1] === num)
    const fpt = SECTION_CANDIDATES.find((c) => c.kind === "fixed" && c.number === num)
    const id = own?.section_id ?? fpt?.id
    if (id) byNumber.add(id)
  }
  return [...byNumber]
}
