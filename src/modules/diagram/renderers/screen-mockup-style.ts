/**
 * Màu + đo chữ cho mockup màn (FLF-410). Màu phụ suy từ màu chính bằng code (không do model): nền nhạt, chữ trên nền màu
 * chính (trắng / đen theo tương phản WCAG), màu nhấn cho chữ trên nền trắng (màu chính quá sáng như vàng ⇒ làm tối đến khi
 * đọc được). Hàm thuần.
 */

import { textWidth } from "../../../shared/diagram/svg-kit.js"

export const WHITE = "#FFFFFF"
export const BLACK = "#000000"
export const TEXT = "#222222"
export const MUTED = "#555555"
export const PLACEHOLDER = "#8A8A8A"
export const BORDER = "#9A9A9A"
export const LINE = "#DDDDDD"
export const CHROME = "#E4E4E4"
export const DIM = "#9E9E9E"
export const DEVICE = "#1E1E1E"
export const DANGER = "#B33A3A"

type Rgb = [number, number, number]

const rgb = (hex: string): Rgb => {
  const h = hex.replace("#", "")
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb
}
const hex = ([r, g, b]: Rgb): string => `#${[r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("").toUpperCase()}`

/** Trộn `a` với `b`: `t = 0` ⇒ a, `t = 1` ⇒ b. */
export const mix = (a: string, b: string, t: number): string => {
  const x = rgb(a)
  const y = rgb(b)
  return hex([0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * t) as Rgb)
}

const luminance = (c: string): number => {
  const [r, g, b] = rgb(c).map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** Tỉ lệ tương phản WCAG 2.x (1…21). */
export const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

export interface MockupPalette {
  primary: string
  /** Chữ trên nền màu chính. */
  onPrimary: string
  /** Chữ / viền nhấn trên nền trắng (link, nút viền, giá). */
  accent: string
  /** Nền nhạt (~10% màu chính): ô ảnh, hàng tiêu đề bảng. */
  soft: string
}

/**
 * Chữ trên nền màu chính luôn đậm và ≥ 15px (header, app bar, nút chính) ⇒ ngưỡng WCAG cho chữ lớn / thành phần UI là 3:1;
 * trắng đạt ngưỡng đó thì dùng trắng (đúng kiểu màn thương hiệu), không ⇒ màu nào tương phản hơn (vàng ⇒ đen).
 * Chữ nhấn trên nền trắng (link, nút viền) là chữ thường ⇒ ngưỡng 4.5:1.
 */
export const ON_PRIMARY_MIN_CONTRAST = 3

export const paletteOf = (primary: string): MockupPalette => {
  const onPrimary = contrast(WHITE, primary) >= ON_PRIMARY_MIN_CONTRAST || contrast(WHITE, primary) >= contrast(BLACK, primary) ? WHITE : BLACK
  let accent = primary
  for (let t = 0.1; contrast(accent, WHITE) < 4.5 && t <= 1; t += 0.1) accent = mix(primary, BLACK, t)
  return { primary, onPrimary, accent, soft: mix(primary, WHITE, 0.9) }
}

const ELLIPSIS = "..."

/** Cắt `s` về bề rộng `max` (px) ở cỡ `size`, thêm `...`. Không cắt được gì có nghĩa ⇒ chuỗi rỗng. */
export const fit = (s: string, size: number, max: number, bold = false): string => {
  if (textWidth(s, size, bold) <= max) return s
  const chars = [...s]
  while (chars.length > 0 && textWidth(`${chars.join("").trimEnd()}${ELLIPSIS}`, size, bold) > max) chars.pop()
  return chars.length > 0 ? `${chars.join("").trimEnd()}${ELLIPSIS}` : ""
}

/** Ngắt dòng theo từ trong bề rộng `max`; quá `maxLines` ⇒ dòng cuối cắt `...`. */
export const wrap = (s: string, size: number, max: number, maxLines: number, bold = false): string[] => {
  const lines: string[] = []
  let current = ""
  for (const word of s.split(/\s+/).filter(Boolean)) {
    const next = current ? `${current} ${word}` : word
    if (textWidth(next, size, bold) <= max || !current) current = next
    else {
      lines.push(current)
      current = word
    }
  }
  if (current) lines.push(current)
  if (lines.length <= maxLines) return lines.map((l) => fit(l, size, max, bold))
  // phần còn lại dồn vào dòng cuối ⇒ chắc chắn dài hơn `max` ⇒ `fit` cắt kèm `...`
  return [...lines.slice(0, maxLines - 1), fit(lines.slice(maxLines - 1).join(" "), size, max, bold)]
}
