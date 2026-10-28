/**
 * svg-geometry.ts
 * ─────────────────────────────────────────────────────────────────
 * Kiểm bố cục trên hình học của `Scene` — luật 9 của `plantuml-conventions/SKILL.md`: một đoạn thẳng, gấp khúc
 * vuông góc chỉ ở kind cho phép, không đường đè chữ / xuyên hình, không chồng đường, chữ không đè chữ / tràn hộp.
 * Còn issue ⇒ renderer không được ra hình (`render_status = error`); sửa bằng phân loại phần tử (`decoration` /
 * `owner` / `container`), không nới ngưỡng.
 */

import type { Point } from "./svg-kit.js"
import { outline, type Scene, type SceneElement } from "./svg-scene.js"

export type GeometryRule = "bend" | "text_overlap" | "text_overflow" | "line_over_text" | "line_overlap" | "line_through_shape"

export interface GeometryIssue {
  rule: GeometryRule
  ids: string[]
  message: string
}

export interface CheckOptions {
  /** Kind cho phép gấp khúc vuông góc (`erd`, `class`, `screen_flow`, `state_machine`). */
  allowBends: boolean
}

/** Sai số song song trục / chồng đường (px). */
const AXIS_TOLERANCE = 0.5
const OVERLAP_EPS = 0.5

type Segment = [Point, Point]

const segments = (pts: readonly Point[]): Segment[] => pts.slice(1).map((p, i): Segment => [pts[i], p])

const project = (poly: readonly Point[], axis: Point): [number, number] => {
  let min = Infinity
  let max = -Infinity
  for (const p of poly) {
    const v = p[0] * axis[0] + p[1] * axis[1]
    if (v < min) min = v
    if (v > max) max = v
  }
  return [min, max]
}

const normals = (poly: readonly Point[]): Point[] => {
  const out: Point[] = []
  const closed = poly.length > 2
  for (let i = 0; i < (closed ? poly.length : 1); i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (len > 0) out.push([-(b[1] - a[1]) / len, (b[0] - a[0]) / len])
  }
  return out
}

/**
 * SAT trên hai đa giác lồi (đoạn thẳng = đa giác 2 đỉnh): giao nhau sâu hơn `eps` trên mọi trục. Độ sâu đo bằng
 * khoảng cách đẩy ra nhỏ nhất (không phải độ dài phần chung) để đoạn thẳng — hình chiếu suy biến thành một điểm trên
 * pháp tuyến của nó — vẫn được tính khi nằm trong hình kia.
 */
export const overlaps = (a: readonly Point[], b: readonly Point[], eps = OVERLAP_EPS): boolean => {
  for (const axis of [...normals(a), ...normals(b)]) {
    const [amin, amax] = project(a, axis)
    const [bmin, bmax] = project(b, axis)
    if (Math.min(amax - bmin, bmax - amin) <= eps) return false
  }
  return true
}

const insideShape = (p: Point, shape: SceneElement, tol: number): boolean => {
  if (shape.type === "ellipse") {
    const dx = (p[0] - shape.cx) / (shape.rx + tol)
    const dy = (p[1] - shape.cy) / (shape.ry + tol)
    return dx * dx + dy * dy <= 1
  }
  const poly = outline(shape)
  return normals(poly).every((n, i) => (p[0] - poly[i][0]) * n[0] + (p[1] - poly[i][1]) * n[1] >= -tol)
}

/** Vùng trong của hình, lùi vào 1px: đường chạm viền ở hai đầu không tính là xuyên. */
const interior = (shape: SceneElement): Point[] => {
  if (shape.type === "ellipse") return outline({ ...shape, rx: Math.max(shape.rx - 1, 0), ry: Math.max(shape.ry - 1, 0) })
  if (shape.type === "rect") return outline({ ...shape, x: shape.x + 1, y: shape.y + 1, w: Math.max(shape.w - 2, 0), h: Math.max(shape.h - 2, 0) })
  return outline(shape)
}

/** Hai đoạn cùng phương, cách nhau < 1px, phần chung > 1px. */
const collinearOverlap = ([a, b]: Segment, [c, d]: Segment): boolean => {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1])
  const len2 = Math.hypot(d[0] - c[0], d[1] - c[1])
  if (len === 0 || len2 === 0) return false
  const u: Point = [(b[0] - a[0]) / len, (b[1] - a[1]) / len]
  const cross = Math.abs(u[0] * (d[1] - c[1]) - u[1] * (d[0] - c[0])) / len2
  if (cross > 0.01) return false
  // khoảng cách của CẢ hai đầu tới đường kia: đoạn dài lệch góc nhỏ vẫn có thể xa dần
  const off = (p: Point) => Math.abs(-u[1] * (p[0] - a[0]) + u[0] * (p[1] - a[1]))
  if (Math.max(off(c), off(d)) >= 1) return false
  const t1 = (c[0] - a[0]) * u[0] + (c[1] - a[1]) * u[1]
  const t2 = (d[0] - a[0]) * u[0] + (d[1] - a[1]) * u[1]
  return Math.min(len, Math.max(t1, t2)) - Math.max(0, Math.min(t1, t2)) > 1
}

const quote = (el: SceneElement): string => `"${el.name}"`

export const checkScene = (scene: Scene, options: CheckOptions): GeometryIssue[] => {
  const issues: GeometryIssue[] = []
  const add = (rule: GeometryRule, els: SceneElement[], what: string) =>
    issues.push({ rule, ids: els.map((e) => e.id), message: `${els.map(quote).join(" và ")}: ${what}` })

  const els = scene.elements
  const texts = els.filter((e) => e.role === "text")
  const shapes = els.filter((e) => e.role === "shape")
  const lines = els.filter((e): e is Extract<SceneElement, { type: "path" }> => e.role === "connector" && e.type === "path")
  const decorations = els.filter((e) => e.role === "decoration")
  const box = new Map(els.map((e) => [e.id, outline(e)]))
  const poly = (e: SceneElement): Point[] => box.get(e.id) ?? []

  // 1. Một đoạn thẳng; gấp khúc chỉ khi kind cho phép và mọi đoạn song song trục
  for (const line of lines) {
    if (line.points.length <= 2) continue
    if (!options.allowBends) add("bend", [line], "đường phải là một đoạn thẳng (kind này không cho gấp khúc)")
    else if (segments(line.points).some(([a, b]) => Math.abs(a[0] - b[0]) > AXIS_TOLERANCE && Math.abs(a[1] - b[1]) > AXIS_TOLERANCE))
      add("bend", [line], "đường gấp khúc phải gồm các đoạn ngang / dọc")
  }

  // 2. Chữ không đè chữ, không đè hình (hoặc trang trí) khác ngoài phần tử chủ
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i]
    for (const u of texts.slice(i + 1)) if (overlaps(poly(t), poly(u))) add("text_overlap", [t, u], "chữ đè lên nhau")
    for (const s of shapes) {
      if (s.id === t.owner || !overlaps(poly(t), poly(s))) continue
      const container = (s.type === "rect" || s.type === "ellipse") && s.container
      if (container && poly(t).every((p) => insideShape(p, s, 0))) continue
      add("text_overlap", [t, s], container ? "chữ cắt viền hình chứa" : "chữ đè lên hình")
    }
    for (const d of decorations) if (d.owner !== t.owner && overlaps(poly(t), poly(d))) add("text_overlap", [t, d], "chữ bị che")
  }

  // 2b. Chữ thuộc một hình nằm trọn trong hình đó
  const byId = new Map(els.map((e) => [e.id, e]))
  for (const t of texts) {
    const owner = t.owner ? byId.get(t.owner) : undefined
    if (owner?.role !== "shape") continue
    if (!poly(t).every((p) => insideShape(p, owner, AXIS_TOLERANCE))) add("text_overflow", [t, owner], "chữ tràn ra ngoài hình")
  }

  // 3. Đường không cắt qua chữ, trừ nhãn của chính nó
  for (const line of lines)
    for (const t of texts) {
      if (t.owner === line.id) continue
      if (segments(line.points).some((seg) => overlaps(seg, poly(t)))) add("line_over_text", [line, t], "đường cắt qua chữ")
    }

  // 4. Hai đoạn không chồng nhau (giữa hai đường, và giữa hai đoạn của cùng một đường — kể cả đoạn kề quay ngược lại)
  for (let i = 0; i < lines.length; i++) {
    const own = segments(lines[i].points)
    for (let a = 0; a < own.length; a++)
      for (let b = a + 1; b < own.length; b++) if (collinearOverlap(own[a], own[b])) add("line_overlap", [lines[i]], "đường tự chồng lên chính nó")
    for (const other of lines.slice(i + 1)) {
      const theirs = segments(other.points)
      if (own.some((s) => theirs.some((o) => collinearOverlap(s, o)))) add("line_overlap", [lines[i], other], "hai đường chồng lên nhau")
    }
  }

  // 5. Đường không xuyên hình (chỉ chạm viền ở hai đầu); hình chứa được miễn
  for (const line of lines)
    for (const s of shapes) {
      if ((s.type === "rect" || s.type === "ellipse") && s.container) continue
      const inner = interior(s)
      if (segments(line.points).some((seg) => overlaps(seg, inner, 0))) add("line_through_shape", [line, s], "đường xuyên qua hình")
    }

  return issues
}
