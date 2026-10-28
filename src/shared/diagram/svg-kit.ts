/**
 * svg-kit.ts
 * ─────────────────────────────────────────────────────────────────
 * Nền chung cho sơ đồ tự dựng (FLF-339, cột engine `svg` của `plantuml-conventions/SKILL.md`): palette Visual Paradigm,
 * đo chữ theo font đóng gói, hình học đầu mũi tên. Hàm thuần — không sinh markup (markup chỉ do `Scene.toSvg`).
 * Bản BE là nguồn sự thật cho renderer; `docs/diagram_guideline/svg-kit.mjs` chỉ dựng hình mẫu cho tài liệu.
 */

import { ASCENT, BOLD_RUNS, DESCENT, REGULAR_RUNS, UNITS_PER_EM } from "./svg-kit-metrics.js"

export const FILL = "#7ACFF5"
export const INK = "#000"
export const PAPER = "#fff"
export const STROKE = 1.2
/** Font đóng gói đứng đầu để resvg chọn đúng file đã dùng để đo chữ. */
export const FONT = "'Liberation Sans', Arial, Helvetica, sans-serif"

export type Point = readonly [number, number]

const toMap = (runs: readonly (readonly number[])[]): Map<number, number> => {
  const map = new Map<number, number>()
  for (const [start, ...widths] of runs) widths.forEach((w, i) => map.set(start + i, w))
  return map
}

const REGULAR = toMap(REGULAR_RUNS)
const BOLD = toMap(BOLD_RUNS)
/** Ký tự ngoài bảng đo như `M` — ước lượng rộng, an toàn cho luật chữ tràn hộp. */
const FALLBACK = { regular: REGULAR.get(77) ?? UNITS_PER_EM, bold: BOLD.get(77) ?? UNITS_PER_EM }

/** Bề rộng (px) của `s` ở cỡ `size`. Dấu tổ hợp (U+0300…) có advance 0 trong font nên không cộng thêm. */
export const textWidth = (s: string, size: number, bold = false): number => {
  const table = bold ? BOLD : REGULAR
  const fallback = bold ? FALLBACK.bold : FALLBACK.regular
  let units = 0
  for (const ch of s) units += table.get(ch.codePointAt(0) ?? 0) ?? fallback
  return (units / UNITS_PER_EM) * size
}

/** Phần trên / dưới baseline của font (px) ở cỡ `size`. */
export const fontAscent = (size: number): number => (ASCENT / UNITS_PER_EM) * size
export const fontDescent = (size: number): number => (DESCENT / UNITS_PER_EM) * size

/** Stereotype UML dạng ASCII `<<name>>` — chuỗi thô, escape lúc `toSvg`. */
export const stereotype = (name: string): string => `<<${name}>>`

// ─── đầu mũi tên: trả đỉnh polygon / polyline ────────────────────

export type ArrowHead = "open" | "classic" | "triangle" | "diamond" | "diamond_filled"

const frame = (tip: Point, from: Point) => {
  const len = Math.hypot(tip[0] - from[0], tip[1] - from[1]) || 1
  const ux = (tip[0] - from[0]) / len
  const uy = (tip[1] - from[1]) / len
  /** Điểm lùi `along` về phía `from`, lệch ngang `side`. */
  return (along: number, side: number): Point => [tip[0] - ux * along - uy * side, tip[1] - uy * along + ux * side]
}

/**
 * Hình đầu mũi tên tại `tip`, đường đi tới từ `from`.
 * - `open`: V mở (dependency, navigation) — polyline, không tô.
 * - `classic`: phi tiêu tô đặc khía lõm (data flow DFD của VP).
 * - `triangle`: tam giác rỗng (generalization, realization).
 * - `diamond` / `diamond_filled`: thoi (aggregation / composition).
 */
export const arrowHeadShape = (style: ArrowHead, tip: Point, from: Point): { points: Point[]; closed: boolean; filled: boolean } => {
  const at = frame(tip, from)
  switch (style) {
    case "open":
      // dài 12, mở ±0.42 rad — như `arrowhead` của docs/diagram_guideline/svg-kit.mjs
      return { points: [at(12 * Math.cos(0.42), 12 * Math.sin(0.42)), tip, at(12 * Math.cos(0.42), -12 * Math.sin(0.42))], closed: false, filled: false }
    case "classic":
      return { points: [tip, at(13, 5.5), at(13 * 0.55, 0), at(13, -5.5)], closed: true, filled: true }
    case "triangle":
      return { points: [tip, at(14, 7), at(14, -7)], closed: true, filled: false }
    case "diamond":
    case "diamond_filled":
      return { points: [tip, at(9, 5.5), at(18, 0), at(9, -5.5)], closed: true, filled: style === "diamond_filled" }
  }
}
