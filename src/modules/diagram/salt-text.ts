/**
 * salt-text.ts
 * ─────────────────────────────────────────────────────────────────
 * Chữ hiển thị trong wireframe salt (FLF-265 N1). Wireframe do model vẽ (`screen-layout.ai.ts`) không có field Spine nào
 * giữ chữ trên widget ⇒ lớp bản dịch lấy chính chữ trong salt làm đơn vị dịch (mảng nhãn của từng hình —
 * `translation-units.ts`), rồi thay lại đúng chỗ khi dựng bản xem đã dịch (`render/localized-diagrams.ts`).
 *
 * Chỉ đụng phần chữ: khung (`{+`, `{#`, `{/`, `{^"…"`, `{*`, `{T`, `{S…`), ô nhập `"…"`, nút `[…]`, dropdown `^…^`,
 * checkbox `[ ]`, radio `( )`, thẻ `<b>` `<u>…</u>` `<&icon>`, dấu ngăn `|`, dòng kẻ `..` và khoảng trắng đệm giữ nguyên
 * từng ký tự. Hàm thuần, không gọi PlantUML — bản thay chữ hỏng cú pháp thì compile-check của người vẽ bắt.
 */

import { isFunctionTable } from "./renderers/screen-layout.renderer.js"

type SpanKind = "quoted" | "button" | "dropdown" | "plain"

interface TextSpan {
  /** Chỉ số dòng trong salt (tách theo `\n`). */
  line: number
  start: number
  end: number
  text: string
  kind: SpanKind
}

const HAS_LETTER = /\p{L}/u
/** Dòng chỉ là khung tài liệu, không có chữ hiển thị. */
const DIRECTIVE_LINE = /^\s*(@(start|end)\w*|salt|skinparam\b.*|'.*)\s*$/i
/**
 * Ký hiệu khung ngay sau `{`: `+ # ! - * / ^`, cây `T`, thanh cuộn `S` / `SI` / `S-`. Chữ cái chỉ là ký hiệu khi đứng
 * riêng (`{T`, `{SI` rồi xuống dòng) — `{Total` là ô chữ.
 */
const FRAME_MARKER = /^(?:(?:SI|S-|S|T)(?=\s|$)|[+#!\-*/^])/
/** Ô checkbox / radio (`[ ]`, `[X]`, `( )`, `(x)`) — ký hiệu, không phải chữ. */
const BOX_MARKER = /^[ xX]?$/
/** Thẻ markup creole `<b>`, `</u>`, `<&person>`, `<color:red>` — không phải chữ. */
const TAG = /^<\/?[&a-z][^>]*>/i
/** Dấu cây / menu đầu ô (`+ Gốc`, `++ Con`) — giữ lại khi thay chữ. */
const LEADING_MARKERS = /^[+*#]+\s*/

/** `s[i]` mở một thẻ markup. */
const tagAt = (s: string, i: number): number => (s[i] === "<" ? (TAG.exec(s.slice(i))?.[0].length ?? 0) : 0)

/** Ký tự kết thúc một đoạn chữ thường: dấu ngăn ô, khung, ô nhập, nút, dropdown hoặc thẻ markup. */
const stopsPlain = (s: string, i: number): boolean => "|{}\"[^".includes(s[i]) || tagAt(s, i) > 0

/** Các đoạn chữ của một dòng salt, theo thứ tự. */
const lineSpans = (s: string, line: number): TextSpan[] => {
  const spans: TextSpan[] = []
  const push = (from: number, to: number, kind: SpanKind) => {
    let start = from
    let end = to
    while (start < end && /\s/.test(s[start])) start++
    while (end > start && /\s/.test(s[end - 1])) end--
    if (kind === "plain") start += LEADING_MARKERS.exec(s.slice(start, end))?.[0].length ?? 0
    const text = s.slice(start, end)
    if (HAS_LETTER.test(text)) spans.push({ line, start, end, text, kind })
  }
  /** Đoạn kẹp giữa hai dấu `open`…`close`; thiếu dấu đóng ⇒ coi phần còn lại là chữ thường. */
  const enclosed = (i: number, close: string, kind: SpanKind): number => {
    const end = s.indexOf(close, i + 1)
    if (end < 0) {
      push(i, s.length, "plain")
      return s.length
    }
    if (!(kind === "button" && BOX_MARKER.test(s.slice(i + 1, end)))) push(i + 1, end, kind)
    return end + 1
  }

  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (/\s/.test(c) || c === "}" || c === "|") {
      i++
    } else if (c === "{") {
      i += 1 + (FRAME_MARKER.exec(s.slice(i + 1))?.[0].length ?? 0)
    } else if (c === '"') {
      i = enclosed(i, '"', "quoted")
    } else if (c === "[") {
      i = enclosed(i, "]", "button")
    } else if (c === "^") {
      i = enclosed(i, "^", "dropdown")
    } else if (c === "(" && /^\([ xX]?\)/.test(s.slice(i))) {
      i += s[i + 1] === ")" ? 2 : 3
    } else if (tagAt(s, i) > 0) {
      i += tagAt(s, i)
    } else {
      let j = i + 1
      while (j < s.length && !stopsPlain(s, j)) j++
      push(i, j, "plain")
      i = j
    }
  }
  return spans
}

/** Salt dạng `@startsalt` hoặc `@startuml` + dòng `salt`. */
const isSalt = (puml: string): boolean => /^@startsalt\b/.test(puml) || /^@startuml\s*\n\s*salt\s*\n/.test(puml)

/** Wireframe model vẽ (hoặc salt viết tay) — không phải bảng Function | Description của renderer code. */
export const isWireframeSalt = (puml: string): boolean => isSalt(puml) && !isFunctionTable(puml)

const spansOf = (puml: string): TextSpan[] =>
  puml.split("\n").flatMap((line, index) => (DIRECTIVE_LINE.test(line) ? [] : lineSpans(line, index)))

const normalize = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase()

/** Mã / dữ liệu mẫu không cần dịch: một token có chữ số (`GC000123`, `SE1614`), e-mail, URL. */
const isSampleToken = (text: string): boolean => (!/\s/.test(text) && /\d/.test(text)) || text.includes("@") || /:\/\//.test(text)

/**
 * Nhãn cần dịch của wireframe — chữ hiển thị KHÁC NHAU theo thứ tự xuất hiện. Bỏ `reserved` (tên màn — thay bằng tên màn
 * đã dịch; tên hệ thống — không dịch), mã / e-mail / URL mẫu, chữ không có chữ cái. Không phải salt / là bảng function ⇒
 * rỗng.
 */
export const wireframeLabels = (puml: string, reserved: readonly (string | null | undefined)[] = []): string[] => {
  if (!isWireframeSalt(puml)) return []
  const skip = new Set(reserved.flatMap((r) => (r && r.trim() ? [normalize(r)] : [])))
  const seen = new Set<string>()
  const out: string[] = []
  for (const { text } of spansOf(puml)) {
    if (seen.has(text) || skip.has(normalize(text)) || isSampleToken(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out
}

/** Chữ dịch an toàn cho vị trí của nó: một dòng, không ký tự cú pháp salt có thể mở / đóng widget ở chỗ đó. */
const sanitize = (kind: SpanKind, text: string): string => {
  let out = text.replace(/[|{}<>]/g, " ")
  if (kind === "quoted") out = out.replace(/"/g, "'")
  else if (kind === "button") out = out.replace(/[[\]]/g, " ")
  else if (kind === "dropdown") out = out.replace(/\^/g, " ")
  else out = out.replace(/["[\]^]/g, " ").replace(LEADING_MARKERS, "")
  return out.replace(/\s+/g, " ").trim()
}

/**
 * Thay chữ hiển thị của salt: `replace(text)` trả chữ mới, `undefined` ⇒ giữ nguyên. Cú pháp, khoảng đệm, thẻ markup
 * không đổi; chữ mới qua `sanitize` (rỗng sau khi lọc ⇒ giữ chữ cũ). Không phải wireframe ⇒ trả nguyên `puml`.
 */
export const localizeSalt = (puml: string, replace: (text: string) => string | undefined): string => {
  if (!isWireframeSalt(puml)) return puml
  const lines = puml.split("\n")
  const spans = spansOf(puml)
  // Thay từ cuối dòng về đầu để chỉ số của các đoạn trước còn đúng
  for (const span of [...spans].reverse()) {
    const next = replace(span.text)
    if (next === undefined) continue
    const safe = sanitize(span.kind, next)
    if (!safe || safe === span.text) continue
    const line = lines[span.line]
    lines[span.line] = `${line.slice(0, span.start)}${safe}${line.slice(span.end)}`
  }
  return lines.join("\n")
}
