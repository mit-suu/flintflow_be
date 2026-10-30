/**
 * orthogonal-ends.ts
 * ─────────────────────────────────────────────────────────────────
 * Đầu mút của đường vuông góc đã định tuyến (`orthogonal-route.ts`) và chỗ đặt nhãn quanh nó — dùng chung cho ERD và
 * class diagram: hướng + điểm đầu mút, vùng cấm quanh ký hiệu, chỗ đặt chữ ngắn (bản số) cạnh đoạn đầu, chỗ đặt nhãn động từ.
 */

import type { Point } from "../../../shared/diagram/svg-kit.js"
import type { LabelSpot, Rect } from "./orthogonal-route.js"

export interface End {
  p: Point
  /** Vector đơn vị từ đầu mút dọc theo đường, rời xa hộp. */
  d: Point
}

export const endOf = (points: readonly Point[], end: 0 | 1): End => {
  const [p, q] = end === 0 ? [points[0], points[1]] : [points[points.length - 1], points[points.length - 2]]
  const len = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1
  return { p, d: [(q[0] - p[0]) / len, (q[1] - p[1]) / len] }
}

export const at = ({ p, d }: End, along: number, side: number): Point => [p[0] + d[0] * along - d[1] * side, p[1] + d[1] * along + d[0] * side]

/** Vùng cấm quanh ký hiệu đầu mút (nhãn khác không được vào). */
export const zoneRect = (end: End, length: number, half: number): Rect => {
  const far = at(end, length, 0)
  const [x0, x1] = [Math.min(end.p[0], far[0]), Math.max(end.p[0], far[0])]
  const [y0, y1] = [Math.min(end.p[1], far[1]), Math.max(end.p[1], far[1])]
  return Math.abs(end.d[0]) > 0.5 ? { x: x0, y: y0 - half, w: x1 - x0, h: 2 * half } : { x: x0 - half, y: y0, w: 2 * half, h: y1 - y0 }
}

/** Chỗ đặt chữ ngắn (`1`, `N`, `Z`) cạnh đoạn đầu: sát hộp trước, hai bên đường. */
export const endSpots = (end: End, w: number, h: number, clear: number): LabelSpot[] => {
  const spots: LabelSpot[] = []
  const vertical = Math.abs(end.d[1]) > 0.5
  for (const along of [8, 16, 24]) {
    for (const side of [1, -1]) {
      const reach = (vertical ? h : w) / 2 + along
      const offset = (vertical ? w : h) / 2 + clear
      spots.push({ at: at(end, reach, side * offset), onLine: false })
    }
  }
  return spots
}

/** Chỗ đặt nhãn động từ: đoạn dài trước; giữa đoạn trước; đè lên đường (nền trắng cắt đường) trước, rồi cạnh đường. */
export const verbSpots = (points: readonly Point[], w: number, h: number): LabelSpot[] => {
  const segs = points.slice(1).map((q, i) => [points[i], q] as const).sort((a, b) => Math.abs(b[1][0] - b[0][0]) + Math.abs(b[1][1] - b[0][1]) - (Math.abs(a[1][0] - a[0][0]) + Math.abs(a[1][1] - a[0][1])))
  const spots: LabelSpot[] = []
  for (const [a, b] of segs) {
    const isH = a[1] === b[1]
    for (const t of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8]) {
      const p: Point = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
      if (isH) spots.push({ at: p, onLine: true }, { at: [p[0], p[1] - h / 2 - 4], onLine: false }, { at: [p[0], p[1] + h / 2 + 4], onLine: false })
      else spots.push({ at: p, onLine: true }, { at: [p[0] + w / 2 + 6, p[1]], onLine: false }, { at: [p[0] - w / 2 - 6, p[1]], onLine: false })
    }
  }
  // Dự phòng khi mọi chỗ trên đều vướng (vòng tự thân hẹp, nhiều đường sát nhau): lệch dọc theo đoạn và xa dần khỏi đường
  const longest = segs[0]
  if (longest) {
    const [a, b] = longest
    const isH = a[1] === b[1]
    const mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
    for (const far of [0, 12, 26, 44]) {
      for (const shift of [0, 1, -1, 2, -2]) {
        for (const side of [1, -1]) {
          const along = shift * ((isH ? w : h) / 2 + 10)
          const off = (isH ? h : w) / 2 + 4 + far
          spots.push({ at: isH ? [mid[0] + along, mid[1] + side * off] : [mid[0] + side * off, mid[1] + along], onLine: false })
        }
      }
    }
  }
  return spots
}

