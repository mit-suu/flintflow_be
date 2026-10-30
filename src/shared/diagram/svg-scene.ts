/**
 * svg-scene.ts
 * ─────────────────────────────────────────────────────────────────
 * `Scene`: renderer chỉ vẽ qua đây, đưa CHUỖI THÔ và toạ độ; scene ghi hình học của từng phần tử (để `checkScene`
 * kiểm bố cục) và `toSvg()` là nơi DUY NHẤT sinh markup + escape. Không có hàm nào khác trả chuỗi SVG ⇒ chữ user
 * không thể chèn phần tử lạ (`<script>`, `<foreignObject>`…).
 */

import { arrowHeadShape, FILL, FONT, fontAscent, fontDescent, INK, PAPER, STROKE, textWidth, type ArrowHead, type Point } from "./svg-kit.js"

export type Role = "shape" | "connector" | "text" | "decoration"
export type Baseline = "alphabetic" | "central"
export type Anchor = "start" | "middle" | "end"

interface Common {
  id: string
  /** Tên đọc được trong thông báo lỗi bố cục (tên actor, entity…). */
  name: string
  role: Role
  /** Phần tử chủ: chữ trong hộp ⇒ id hộp; nhãn / đầu mũi tên ⇒ id đường. */
  owner?: string
  /** 1 = vẽ sau cùng (nhãn đường nằm trên mọi đường). */
  layer: 0 | 1
}

export type SceneElement =
  | (Common & { type: "rect"; x: number; y: number; w: number; h: number; fill: string; dashed: boolean; container: boolean; rotate: number; radius: number })
  | (Common & { type: "ellipse"; cx: number; cy: number; rx: number; ry: number; fill: string; dashed: boolean; container: boolean })
  | (Common & { type: "path"; points: Point[]; closed: boolean; fill: string; dashed: boolean; /** Bề dày nét; thiếu ⇒ theo vai trò. */ stroke?: number })
  | (Common & { type: "text"; x: number; y: number; text: string; size: number; bold: boolean; anchor: Anchor; baseline: Baseline; rotate: number; italic: boolean })

export interface ShapeOptions {
  name?: string
  fill?: string
  dashed?: boolean
  /** Hộp chứa (system boundary, swimlane): chữ / đường bên trong được phép, chỉ kiểm cắt viền. */
  container?: boolean
  /** Bo góc (px) của hình chữ nhật — chỉ ảnh hưởng nét vẽ; bộ kiểm bố cục vẫn coi là hình chữ nhật, nên chữ phải cách góc ≥ bán kính. */
  radius?: number
}

export interface TextOptions {
  name?: string
  size?: number
  bold?: boolean
  /** In nghiêng (actor trừu tượng). Bề rộng đo theo Regular: Italic của Liberation Sans cùng advance width. */
  italic?: boolean
  anchor?: Anchor
  baseline?: Baseline
  /** Độ, quay quanh (x, y). */
  rotate?: number
  owner?: string
}

const COLOR = /^(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}|none)$/
const color = (value: string | undefined, fallback: string): string => {
  const c = value ?? fallback
  if (!COLOR.test(c)) throw new Error(`svg-scene: màu không hợp lệ ${JSON.stringify(c)}`)
  return c
}

/** Số làm tròn 2 chữ số ⇒ markup tất định. */
const num = (v: number): string => {
  if (!Number.isFinite(v)) throw new Error(`svg-scene: toạ độ không hữu hạn (${v})`)
  const r = Math.round(v * 100) / 100
  return String(Object.is(r, -0) ? 0 : r)
}

/** Ký tự XML 1.0 cấm + surrogate lẻ. */
const FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g
const esc = (s: string): string =>
  s
    .replace(FORBIDDEN, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")

const rotateAround = (p: Point, pivot: Point, deg: number): Point => {
  if (deg === 0) return p
  const a = (deg * Math.PI) / 180
  const dx = p[0] - pivot[0]
  const dy = p[1] - pivot[1]
  return [pivot[0] + dx * Math.cos(a) - dy * Math.sin(a), pivot[1] + dx * Math.sin(a) + dy * Math.cos(a)]
}

const ELLIPSE_SIDES = 64

/** Đa giác bao phần tử (ellipse xấp xỉ 64 cạnh, chữ = hộp chữ đã quay). Dùng cho bbox và bộ kiểm hình học. */
export const outline = (el: SceneElement): Point[] => {
  switch (el.type) {
    case "rect": {
      const c: Point = [el.x + el.w / 2, el.y + el.h / 2]
      const corners: Point[] = [[el.x, el.y], [el.x + el.w, el.y], [el.x + el.w, el.y + el.h], [el.x, el.y + el.h]]
      return corners.map((p) => rotateAround(p, c, el.rotate))
    }
    case "ellipse":
      return Array.from({ length: ELLIPSE_SIDES }, (_, i): Point => {
        const a = (2 * Math.PI * i) / ELLIPSE_SIDES
        return [el.cx + el.rx * Math.cos(a), el.cy + el.ry * Math.sin(a)]
      })
    case "path":
      return el.points
    case "text": {
      const w = textWidth(el.text, el.size, el.bold)
      const left = el.anchor === "start" ? el.x : el.anchor === "middle" ? el.x - w / 2 : el.x - w
      const ascent = fontAscent(el.size)
      const descent = fontDescent(el.size)
      const [top, bottom] = el.baseline === "alphabetic" ? [el.y - ascent, el.y + descent] : [el.y - (ascent + descent) / 2, el.y + (ascent + descent) / 2]
      const corners: Point[] = [[left, top], [left + w, top], [left + w, bottom], [left, bottom]]
      return corners.map((p) => rotateAround(p, [el.x, el.y], el.rotate))
    }
  }
}

/** Góc (độ) của đoạn a→b quay về khoảng (-90, 90] để chữ dọc theo đường luôn đứng. */
const uprightAngle = (a: Point, b: Point): number => {
  let deg = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI
  if (deg > 90) deg -= 180
  if (deg <= -90) deg += 180
  return deg
}

/** Phần tử `toSvg` được phép sinh — test injection kiểm SVG chỉ có các tên này. */
export const SVG_ELEMENT_WHITELIST: ReadonlySet<string> = new Set(["svg", "g", "rect", "circle", "ellipse", "line", "polyline", "polygon", "path", "text", "title"])

export class Scene {
  private readonly items: SceneElement[] = []
  private readonly ids = new Set<string>()

  get elements(): readonly SceneElement[] {
    return this.items
  }

  find(id: string): SceneElement | undefined {
    return this.items.find((el) => el.id === id)
  }

  private push(el: SceneElement): string {
    if (this.ids.has(el.id)) throw new Error(`svg-scene: trùng id ${el.id}`)
    // hình suy biến làm lệch cạnh ↔ pháp tuyến của bộ kiểm hình học
    if ((el.type === "rect" && !(el.w > 0 && el.h > 0)) || (el.type === "ellipse" && !(el.rx > 0 && el.ry > 0))) {
      throw new Error(`svg-scene: hình ${el.id} phải có kích thước dương`)
    }
    this.ids.add(el.id)
    this.items.push(el)
    return el.id
  }

  rect(id: string, x: number, y: number, w: number, h: number, opts: ShapeOptions = {}): string {
    const fill = color(opts.fill, opts.container ? "none" : FILL)
    return this.push({ type: "rect", id, name: opts.name ?? id, role: "shape", layer: 0, x, y, w, h, fill, dashed: opts.dashed ?? false, container: opts.container ?? false, rotate: 0, radius: opts.radius ?? 0 })
  }

  circle(id: string, cx: number, cy: number, r: number, opts: ShapeOptions = {}): string {
    return this.ellipse(id, cx, cy, r, r, opts)
  }

  ellipse(id: string, cx: number, cy: number, rx: number, ry: number, opts: ShapeOptions = {}): string {
    const fill = color(opts.fill, opts.container ? "none" : FILL)
    return this.push({ type: "ellipse", id, name: opts.name ?? id, role: "shape", layer: 0, cx, cy, rx, ry, fill, dashed: opts.dashed ?? false, container: opts.container ?? false })
  }

  /** Đa giác lồi đóng kín là một hình (decision node của activity diagram…): chữ / đường không được xuyên vào trong. */
  polygon(id: string, pts: Point[], opts: ShapeOptions = {}): string {
    if (pts.length < 3) throw new Error(`svg-scene: đa giác ${id} cần ít nhất 3 đỉnh`)
    const fill = color(opts.fill, FILL)
    return this.push({ type: "path", id, name: opts.name ?? id, role: "shape", layer: 0, points: pts, closed: true, fill, dashed: opts.dashed ?? false })
  }

  /** Đường nối thẳng a → b. */
  line(id: string, a: Point, b: Point, opts: { name?: string; dashed?: boolean } = {}): string {
    return this.polyline(id, [a, b], opts)
  }

  /** Đường nối gấp khúc (chỉ hợp lệ khi kind cho phép gấp khúc, mọi đoạn song song trục). */
  polyline(id: string, points: Point[], opts: { name?: string; dashed?: boolean } = {}): string {
    if (points.length < 2) throw new Error(`svg-scene: đường ${id} cần ít nhất 2 điểm`)
    return this.push({ type: "path", id, name: opts.name ?? id, role: "connector", layer: 0, points, closed: false, fill: "none", dashed: opts.dashed ?? false })
  }

  text(id: string, x: number, y: number, text: string, opts: TextOptions = {}): string {
    return this.push({
      type: "text",
      id,
      name: opts.name ?? text,
      role: "text",
      layer: 0,
      owner: opts.owner,
      x,
      y,
      text,
      size: opts.size ?? 14,
      bold: opts.bold ?? false,
      italic: opts.italic ?? false,
      anchor: opts.anchor ?? "middle",
      baseline: opts.baseline ?? "alphabetic",
      rotate: opts.rotate ?? 0
    })
  }

  private connector(lineId: string): Extract<SceneElement, { type: "path" }> {
    const line = this.find(lineId)
    if (!line || line.role !== "connector" || line.type !== "path") throw new Error(`svg-scene: ${lineId} không phải đường nối`)
    return line
  }

  /**
   * Nhãn trên đường `lineId`: chữ dọc theo đoạn dài nhất (đứng thẳng), giữa đoạn, trên nền trắng cắt ngang đường.
   * `along: false` ⇒ chữ nằm ngang. Nhãn vẽ ở lớp trên cùng.
   */
  label(lineId: string, text: string, opts: { size?: number; along?: boolean; at?: Point } = {}): string {
    const line = this.connector(lineId)
    const size = opts.size ?? 13
    let seg: [Point, Point] = [line.points[0], line.points[1]]
    for (let i = 1; i < line.points.length - 1; i++) {
      const cand: [Point, Point] = [line.points[i], line.points[i + 1]]
      if (Math.hypot(cand[1][0] - cand[0][0], cand[1][1] - cand[0][1]) > Math.hypot(seg[1][0] - seg[0][0], seg[1][1] - seg[0][1])) seg = cand
    }
    const at = opts.at ?? [(seg[0][0] + seg[1][0]) / 2, (seg[0][1] + seg[1][1]) / 2]
    const rotate = opts.along === false ? 0 : uprightAngle(seg[0], seg[1])
    const w = textWidth(text, size) + 8
    const h = size + 4
    const id = `${lineId}#label`
    this.push({ type: "rect", id: `${id}-bg`, name: `${line.name} (nền nhãn)`, role: "decoration", owner: lineId, layer: 1, x: at[0] - w / 2, y: at[1] - h / 2, w, h, fill: PAPER, dashed: false, container: false, rotate, radius: 0 })
    return this.push({ type: "text", id, name: text, role: "text", owner: lineId, layer: 1, x: at[0], y: at[1], text, size, bold: false, italic: false, anchor: "middle", baseline: "central", rotate })
  }

  /**
   * Nhãn nhiều dòng (ngang) trên / cạnh đường `lineId`, tâm tại `at`, nền trắng. Dòng đầu mang id `<lineId>#label`, dòng
   * thứ i mang `<lineId>#label-<i>`. Nhãn vẽ ở lớp trên cùng.
   */
  labelBlock(lineId: string, lines: readonly string[], at: Point, opts: { size?: number; lineHeight?: number } = {}): string[] {
    const line = this.connector(lineId)
    if (lines.length === 0) throw new Error(`svg-scene: nhãn của ${lineId} không có dòng nào`)
    const size = opts.size ?? 13
    const lh = opts.lineHeight ?? size + 4
    const w = Math.max(...lines.map((l) => textWidth(l, size))) + 8
    const h = lines.length * lh + 4
    const id = `${lineId}#label`
    this.push({ type: "rect", id: `${id}-bg`, name: `${line.name} (nền nhãn)`, role: "decoration", owner: lineId, layer: 1, x: at[0] - w / 2, y: at[1] - h / 2, w, h, fill: PAPER, dashed: false, container: false, rotate: 0, radius: 0 })
    return lines.map((text, i) =>
      this.push({ type: "text", id: i === 0 ? id : `${id}-${i}`, name: text, role: "text", owner: lineId, layer: 1, x: at[0], y: at[1] + (i - (lines.length - 1) / 2) * lh, text, size, bold: false, italic: false, anchor: "middle", baseline: "central", rotate: 0 })
    )
  }

  /** Nét trang trí thuộc `owner` (ký hiệu đầu mút ER, đường chia ngăn trong hộp): không chịu luật đường / hình của `checkScene`, chỉ bị chữ của phần tử khác cắt qua. */
  decoration(id: string, owner: string, pts: Point[], opts: { closed?: boolean; fill?: string } = {}): string {
    if (pts.length < 2) throw new Error(`svg-scene: nét ${id} cần ít nhất 2 điểm`)
    const closed = opts.closed ?? false
    return this.push({ type: "path", id, name: id, role: "decoration", owner, layer: 0, points: pts, closed, fill: closed ? color(opts.fill, PAPER) : "none", dashed: false, stroke: STROKE })
  }

  /** Vòng tròn trang trí thuộc `owner` (số không / chấm đặc ở đầu mút). */
  decorationCircle(id: string, owner: string, cx: number, cy: number, r: number, fill: string): string {
    return this.push({ type: "ellipse", id, name: id, role: "decoration", owner, layer: 0, cx, cy, rx: r, ry: r, fill: color(fill, PAPER), dashed: false, container: false })
  }

  /** Đầu mũi tên ở `end` của đường (`"end"` = điểm cuối, `"start"` = điểm đầu). */
  arrow(lineId: string, style: ArrowHead, end: "end" | "start" = "end"): string {
    const pts = this.connector(lineId).points
    const [tip, from] = end === "end" ? [pts[pts.length - 1], pts[pts.length - 2]] : [pts[0], pts[1]]
    const shape = arrowHeadShape(style, tip, from)
    const fill = shape.filled ? INK : shape.closed ? PAPER : "none"
    return this.push({ type: "path", id: `${lineId}#${end}`, name: `${this.connector(lineId).name} (đầu mũi tên)`, role: "decoration", owner: lineId, layer: 0, points: shape.points, closed: shape.closed, fill, dashed: false })
  }

  /** Bbox (đã cộng `margin`) của mọi phần tử. */
  bounds(margin = 20): { x: number; y: number; w: number; h: number } {
    const pts = this.items.flatMap(outline)
    if (pts.length === 0) return { x: 0, y: 0, w: 2 * margin, h: 2 * margin }
    const xs = pts.map((p) => p[0])
    const ys = pts.map((p) => p[1])
    const x = Math.floor(Math.min(...xs) - margin)
    const y = Math.floor(Math.min(...ys) - margin)
    return { x, y, w: Math.ceil(Math.max(...xs) + margin) - x, h: Math.ceil(Math.max(...ys) + margin) - y }
  }

  /** Markup SVG tất định. Mọi chữ đi qua `esc` (escape + bỏ ký tự XML cấm); chỉ dùng phần tử trong whitelist. */
  toSvg(title?: string, margin = 20): string {
    const b = this.bounds(margin)
    const body = [...this.items].sort((a, c) => a.layer - c.layer).map(markup)
    return [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<svg xmlns="http://www.w3.org/2000/svg" width="${b.w}" height="${b.h}" viewBox="${b.x} ${b.y} ${b.w} ${b.h}">`,
      ...(title ? [`<title>${esc(title)}</title>`] : []),
      `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="${PAPER}"/>`,
      ...body,
      `</svg>`,
      ""
    ].join("\n")
  }
}

const strokeAttrs = (dashed: boolean, width = STROKE): string => ` stroke="${INK}" stroke-width="${width}"${dashed ? ` stroke-dasharray="6,4"` : ""}`
const points = (pts: readonly Point[]): string => pts.map((p) => `${num(p[0])},${num(p[1])}`).join(" ")

const markup = (el: SceneElement): string => {
  switch (el.type) {
    case "rect": {
      const transform = el.rotate ? ` transform="rotate(${num(el.rotate)} ${num(el.x + el.w / 2)} ${num(el.y + el.h / 2)})"` : ""
      // nền nhãn: không viền
      const stroke = el.role === "decoration" ? "" : strokeAttrs(el.dashed)
      const round = el.radius > 0 ? ` rx="${num(el.radius)}" ry="${num(el.radius)}"` : ""
      return `<rect x="${num(el.x)}" y="${num(el.y)}" width="${num(el.w)}" height="${num(el.h)}"${round} fill="${el.fill}"${stroke}${transform}/>`
    }
    case "ellipse":
      return el.rx === el.ry
        ? `<circle cx="${num(el.cx)}" cy="${num(el.cy)}" r="${num(el.rx)}" fill="${el.fill}"${strokeAttrs(el.dashed)}/>`
        : `<ellipse cx="${num(el.cx)}" cy="${num(el.cy)}" rx="${num(el.rx)}" ry="${num(el.ry)}" fill="${el.fill}"${strokeAttrs(el.dashed)}/>`
    case "path":
      if (el.closed) return `<polygon points="${points(el.points)}" fill="${el.fill}"${strokeAttrs(el.dashed, el.stroke ?? (el.role === "shape" ? STROKE : 0.8))} stroke-linejoin="miter"/>`
      if (el.points.length === 2) {
        const [a, b] = el.points
        return `<line x1="${num(a[0])}" y1="${num(a[1])}" x2="${num(b[0])}" y2="${num(b[1])}"${strokeAttrs(el.dashed)}/>`
      }
      return `<polyline points="${points(el.points)}" fill="none"${strokeAttrs(el.dashed)}/>`
    case "text": {
      const transform = el.rotate ? ` transform="rotate(${num(el.rotate)} ${num(el.x)} ${num(el.y)})"` : ""
      const baseline = el.baseline === "central" ? ` dominant-baseline="central"` : ""
      const weight = el.bold ? ` font-weight="bold"` : ""
      const style = el.italic ? ` font-style="italic"` : ""
      return `<text x="${num(el.x)}" y="${num(el.y)}" font-family="${esc(FONT)}" font-size="${num(el.size)}" text-anchor="${el.anchor}"${baseline}${weight}${style} fill="${INK}"${transform}>${esc(el.text)}</text>`
    }
  }
}
