/**
 * Vẽ từng block của ScreenSpec (FLF-410) vào `Scene`, từ trên xuống trong một vùng ngang `area`. Trả toạ độ y sau block
 * cuối. Dùng chung cho trang (web / mobile) và hộp thoại pop-up. Phân loại phần tử theo luật bố cục của `checkScene`:
 * ô nhập / nút là hình, chữ trong đó có `owner`; thẻ, hàng bảng, bộ đếm số lượng là hình chứa (nhiều chữ bên trong).
 */

import { textWidth } from "../../../shared/diagram/svg-kit.js"
import type { Scene } from "../../../shared/diagram/svg-scene.js"
import type { ScreenBlock } from "../screen-spec.js"
import { BORDER, DANGER, fit, LINE, MUTED, PLACEHOLDER, TEXT, WHITE, wrap, type MockupPalette } from "./screen-mockup-style.js"

export interface BlockContext {
  scene: Scene
  pal: MockupPalette
  mobile: boolean
  /** Id duy nhất trong scene. */
  id: (key: string) => string
}

export interface Area {
  x: number
  w: number
}

const LABEL = 15
const INPUT_TEXT = 14
const COL_GAP = 22

const inputHeight = (c: BlockContext) => (c.mobile ? 42 : 34)
const buttonHeight = (c: BlockContext) => (c.mobile ? 46 : 38)
const radius = (c: BlockContext) => (c.mobile ? 6 : 4)

/** Ô nhập dạng hộp + chữ mẫu; trả id ô. */
const input = (c: BlockContext, key: string, x: number, y: number, w: number, h: number, placeholder: string, opts: { chevron?: boolean; icon?: boolean; multiline?: boolean } = {}): string => {
  const box = c.scene.rect(c.id(key), x, y, w, h, { fill: WHITE, stroke: BORDER, strokeWidth: 1, radius: radius(c), name: placeholder || key })
  const left = opts.icon ? 34 : 12
  const right = opts.chevron ? 32 : 12
  if (opts.icon) {
    c.scene.decorationCircle(c.id(`${key}-lens`), box, x + 17, y + h / 2 - 1, 5.5, WHITE, { stroke: MUTED })
    c.scene.decoration(c.id(`${key}-lens-h`), box, [[x + 21, y + h / 2 + 3], [x + 25, y + h / 2 + 7]], { stroke: MUTED, strokeWidth: 1.5 })
  }
  if (opts.chevron) {
    const cx = x + w - 18
    c.scene.decoration(c.id(`${key}-chev`), box, [[cx - 5, y + h / 2 - 3], [cx, y + h / 2 + 2], [cx + 5, y + h / 2 - 3]], { stroke: MUTED, strokeWidth: 1.5 })
  }
  const text = fit(placeholder, INPUT_TEXT, w - left - right)
  if (text) c.scene.text(c.id(`${key}-ph`), x + left, y + (opts.multiline ? 18 : h / 2), text, { size: INPUT_TEXT, anchor: "start", baseline: "central", owner: box, color: PLACEHOLDER })
  return box
}

/** Nút đặc (`primary`) / viền; trả id nút. */
const button = (c: BlockContext, key: string, x: number, y: number, w: number, label: string, primary: boolean): string => {
  const h = buttonHeight(c)
  const box = c.scene.rect(c.id(key), x, y, w, h, {
    fill: primary ? c.pal.primary : WHITE,
    stroke: primary ? c.pal.primary : c.pal.accent,
    strokeWidth: 1.5,
    radius: c.mobile ? 8 : 4,
    name: label
  })
  const text = fit(label, LABEL, w - 24, primary)
  if (text) c.scene.text(c.id(`${key}-t`), x + w / 2, y + h / 2, text, { size: LABEL, bold: primary, baseline: "central", owner: box, color: primary ? c.pal.onPrimary : c.pal.accent })
  return box
}

const buttonWidth = (label: string, primary: boolean) => Math.max(textWidth(label, LABEL, primary) + 40, 96)

const label = (c: BlockContext, key: string, x: number, y: number, s: string, w: number, color = MUTED): void => {
  const text = fit(s, LABEL, w)
  if (text) c.scene.text(c.id(key), x, y, text, { size: LABEL, anchor: "start", color })
}

type Drawer<T extends ScreenBlock["type"]> = (c: BlockContext, b: Extract<ScreenBlock, { type: T }>, a: Area, y: number, key: string, cols: number) => number

const fields: Drawer<"fields"> = (c, b, a, y, key, cols) => {
  const n = c.mobile ? 1 : Math.max(1, Math.min(cols, b.items.length))
  const colW = (a.w - COL_GAP * (n - 1)) / n
  for (let i = 0; i < b.items.length; i += n) {
    const row = b.items.slice(i, i + n)
    let rowH = 0
    row.forEach((f, j) => {
      const x = a.x + j * (colW + COL_GAP)
      const h = f.kind === "textarea" ? inputHeight(c) * 2.4 : inputHeight(c)
      label(c, `${key}-${i + j}-l`, x, y + 15, `${f.label}${f.required ? " *" : ""}`, colW)
      const placeholder = f.placeholder ?? (f.kind === "password" ? "••••••••" : "")
      input(c, `${key}-${i + j}`, x, y + 22, colW, h, placeholder, { chevron: f.kind === "select", multiline: f.kind === "textarea" })
      rowH = Math.max(rowH, 22 + h)
    })
    y += rowH + 14
  }
  return y + 4
}

const checks = (c: BlockContext, b: Extract<ScreenBlock, { type: "checkbox" | "radio" }>, a: Area, y: number, key: string): number => {
  const options = b.options && b.options.length > 0 ? b.options : b.label ? [b.label] : []
  if (b.label && b.options && b.options.length > 0) {
    label(c, `${key}-l`, a.x, y + 15, b.label, a.w)
    y += 26
  }
  options.forEach((o, i) => {
    if (b.type === "radio") {
      const dot = c.scene.circle(c.id(`${key}-${i}-c`), a.x + 9, y + 10, 8, { fill: WHITE, stroke: BORDER, strokeWidth: 1 })
      if (i === 0) c.scene.decorationCircle(c.id(`${key}-${i}-d`), dot, a.x + 9, y + 10, 4, c.pal.accent, { stroke: "none" })
    } else c.scene.rect(c.id(`${key}-${i}-c`), a.x, y + 2, 16, 16, { fill: WHITE, stroke: BORDER, strokeWidth: 1, radius: 3 })
    label(c, `${key}-${i}-t`, a.x + 26, y + 15, o, a.w - 26, TEXT)
    y += 30
  })
  return y + 4
}

const buttons: Drawer<"buttons"> = (c, b, a, y, key) => {
  const h = buttonHeight(c)
  if (c.mobile) {
    b.items.forEach((btn, i) => {
      button(c, `${key}-${i}`, a.x, y, a.w, btn.label, btn.primary ?? false)
      y += h + 12
    })
    return y + 6
  }
  let x = a.x
  b.items.forEach((btn, i) => {
    const w = Math.min(buttonWidth(btn.label, btn.primary ?? false), a.w)
    if (x > a.x && x + w > a.x + a.w) {
      x = a.x
      y += h + 12
    }
    button(c, `${key}-${i}`, x, y, w, btn.label, btn.primary ?? false)
    x += w + 16
  })
  return y + h + 20
}

const link: Drawer<"link"> = (c, b, a, y, key) => {
  const text = fit(b.text, LABEL, a.w)
  if (text) c.scene.text(c.id(key), c.mobile ? a.x + a.w / 2 : a.x, y + 15, text, { size: LABEL, anchor: c.mobile ? "middle" : "start", color: c.pal.accent })
  return y + 34
}

const paragraph: Drawer<"text"> = (c, b, a, y, key) => {
  const lines = wrap(b.text, LABEL, a.w, 3, b.strong ?? false)
  lines.forEach((line, i) => c.scene.text(c.id(`${key}-${i}`), a.x, y + 15 + i * 22, line, { size: LABEL, anchor: "start", bold: b.strong ?? false, color: TEXT }))
  return y + lines.length * 22 + 12
}

/** Ô nhập + nút trên một hàng (`search` / `inline`). */
const inputRow = (c: BlockContext, a: Area, y: number, key: string, placeholder: string, buttonLabel: string | undefined, primary: boolean, maxWeb: number, icon: boolean): number => {
  const total = c.mobile ? a.w : Math.min(a.w, maxWeb)
  const bw = buttonLabel ? Math.min(buttonWidth(buttonLabel, primary), total / 2) : 0
  const h = Math.max(inputHeight(c), buttonHeight(c))
  input(c, key, a.x, y, total - (bw ? bw + 10 : 0), h, placeholder, { icon })
  if (buttonLabel) button(c, `${key}-b`, a.x + total - bw, y, bw, buttonLabel, primary)
  return y + h + 20
}

const items: Drawer<"items"> = (c, b, a, y, key) => {
  const h = 96
  const img = h - 24
  for (const [i, it] of b.items.entries()) {
    const k = `${key}-${i}`
    c.scene.rect(c.id(k), a.x, y, a.w, h, { fill: WHITE, stroke: LINE, strokeWidth: 1, radius: 6, container: true, name: it.name })
    const pic = c.scene.rect(c.id(`${k}-img`), a.x + 12, y + 12, img, img, { fill: c.pal.soft, stroke: "none", radius: 4 })
    c.scene.decoration(c.id(`${k}-x1`), pic, [[a.x + 12, y + 12], [a.x + 12 + img, y + 12 + img]], { stroke: "#CCCCCC", strokeWidth: 1 })
    c.scene.decoration(c.id(`${k}-x2`), pic, [[a.x + 12 + img, y + 12], [a.x + 12, y + 12 + img]], { stroke: "#CCCCCC", strokeWidth: 1 })
    const tx = a.x + img + 28
    const stepper = it.qty !== undefined
    const textW = a.w - (tx - a.x) - (c.mobile ? 12 : 90)
    const lowerW = a.w - (tx - a.x) - (stepper ? 120 : 12)
    const name = fit(it.name, LABEL, textW, true)
    if (name) c.scene.text(c.id(`${k}-n`), tx, y + 28, name, { size: LABEL, bold: true, anchor: "start", color: TEXT })
    const meta = fit(it.meta ?? "", 13, lowerW)
    if (meta) c.scene.text(c.id(`${k}-m`), tx, y + 50, meta, { size: 13, anchor: "start", color: MUTED })
    const price = fit(it.price ?? "", LABEL, lowerW, true)
    if (price) c.scene.text(c.id(`${k}-p`), tx, y + 78, price, { size: LABEL, bold: true, anchor: "start", color: c.pal.accent })
    if (!c.mobile) c.scene.text(c.id(`${k}-rm`), a.x + a.w - 14, y + 28, "Remove", { size: 13, anchor: "end", color: DANGER })
    if (stepper) {
      const sx = a.x + a.w - 108
      const sy = y + h - 40
      c.scene.rect(c.id(`${k}-q`), sx, sy, 96, 28, { fill: WHITE, stroke: BORDER, strokeWidth: 1, radius: 4, container: true })
      c.scene.text(c.id(`${k}-q-`), sx + 16, sy + 14, "-", { size: 16, baseline: "central", color: TEXT })
      c.scene.text(c.id(`${k}-qn`), sx + 48, sy + 14, String(it.qty), { size: LABEL, baseline: "central", color: TEXT })
      c.scene.text(c.id(`${k}-q+`), sx + 80, sy + 14, "+", { size: 16, baseline: "central", color: TEXT })
    }
    y += h + 12
  }
  return y + 6
}

const ROW_H = 36
const CELL = 14

const table: Drawer<"table"> = (c, b, a, y, key) => {
  const maxCols = Math.max(1, Math.floor(a.w / 70))
  const columns = b.columns.slice(0, maxCols)
  const natural = columns.map((col, j) => Math.max(60, textWidth(col, CELL, true) + 24, ...b.rows.map((r) => textWidth(r[j] ?? "", CELL) + 24)))
  const scale = a.w / natural.reduce((s, w) => s + w, 0)
  const widths = natural.map((w) => w * scale)
  const row = (k: string, cells: readonly string[], header: boolean) => {
    c.scene.rect(c.id(k), a.x, y, a.w, ROW_H, { fill: header ? c.pal.soft : WHITE, stroke: LINE, strokeWidth: 1, container: true })
    let x = a.x
    columns.forEach((_, j) => {
      const text = fit(cells[j] ?? "", CELL, widths[j] - 16, header)
      if (text) c.scene.text(c.id(`${k}-${j}`), x + 10, y + ROW_H / 2, text, { size: CELL, bold: header, anchor: "start", baseline: "central", color: TEXT })
      x += widths[j]
    })
    y += ROW_H
  }
  row(`${key}-h`, columns, true)
  b.rows.forEach((r, i) => row(`${key}-${i}`, r, false))
  return y + 18
}

const summary: Drawer<"summary"> = (c, b, a, y, key) => {
  c.scene.rect(c.id(`${key}-hr`), a.x, y, a.w, 1, { fill: LINE, stroke: "none" })
  y += 28
  const left = c.mobile || a.w < 520 ? a.x : a.x + a.w - 380
  const half = (a.x + a.w - left) / 2 - 8
  for (const [i, [k, v, strong]] of b.rows.entries()) {
    const kt = fit(k, LABEL, half, strong ?? false)
    const vt = fit(v, LABEL, half, strong ?? false)
    if (kt) c.scene.text(c.id(`${key}-${i}-k`), left, y, kt, { size: LABEL, bold: strong ?? false, anchor: "start", color: TEXT })
    if (vt) c.scene.text(c.id(`${key}-${i}-v`), a.x + a.w, y, vt, { size: LABEL, bold: strong ?? false, anchor: "end", color: strong ? c.pal.accent : TEXT })
    y += 28
  }
  return y + 8
}

const image: Drawer<"image"> = (c, b, a, y, key) => {
  const h = c.mobile ? 150 : 200
  const box = c.scene.rect(c.id(key), a.x, y, a.w, h, { fill: c.pal.soft, stroke: "#BBBBBB", strokeWidth: 1, dashed: true, radius: 6, name: b.label })
  const text = fit(b.label, LABEL, a.w - 24)
  if (text) c.scene.text(c.id(`${key}-t`), a.x + a.w / 2, y + h / 2, text, { size: LABEL, baseline: "central", owner: box, color: MUTED })
  return y + h + 16
}

/** Vẽ các block từ `y`; trả y sau block cuối. `cols`: số ô nhập mỗi hàng (web). */
export const drawBlocks = (c: BlockContext, blocks: readonly ScreenBlock[], a: Area, y: number, cols: number): number => {
  blocks.forEach((b, i) => {
    const key = `b${i}`
    switch (b.type) {
      case "fields":
        y = fields(c, b, a, y, key, cols)
        break
      case "checkbox":
      case "radio":
        y = checks(c, b, a, y, key)
        break
      case "buttons":
        y = buttons(c, b, a, y, key, cols)
        break
      case "link":
        y = link(c, b, a, y, key, cols)
        break
      case "text":
        y = paragraph(c, b, a, y, key, cols)
        break
      case "search":
        y = inputRow(c, a, y, key, b.placeholder, b.button, true, 640, true)
        break
      case "inline":
        y = inputRow(c, a, y, key, b.placeholder, b.button, false, 460, false)
        break
      case "items":
        y = items(c, b, a, y, key, cols)
        break
      case "table":
        y = table(c, b, a, y, key, cols)
        break
      case "summary":
        y = summary(c, b, a, y, key, cols)
        break
      case "image":
        y = image(c, b, a, y, key, cols)
        break
    }
  })
  return y
}
