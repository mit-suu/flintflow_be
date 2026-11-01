/**
 * legacy-flow.ts
 * ─────────────────────────────────────────────────────────────────
 * `screens[].flow_to` đổi từ `string[]` (id màn đích) sang `{ to, trigger?, guard? }[]`. Dạng chuỗi còn sống VĨNH VIỄN ở
 * baseline snapshot, lịch sử `changes`, prompt / output model cũ, và doc `spines` chưa chạy `migrate:flow-edges`. Mọi
 * đường đọc / so sánh đi qua đây:
 * - `legacyFlowEdge`: preprocess phần tử `flow_to[]` trong `spineSchema` (đọc Mongo, baseline, change root).
 * - `normalizeFlowAt`: value của op / change tại một path, để op engine chỉ lưu dạng mới và undo/revert change cũ so khớp.
 */

import { isRecord } from "./path-resolver.js"

const blank = (v: unknown): boolean => v === undefined || v === null || (typeof v === "string" && v.trim() === "")

/**
 * Chuỗi ⇒ `{ to }`. Object: bỏ `trigger` / `guard` rỗng (model hay ghi `""` hoặc `null` cho "không có"), cắt khoảng trắng
 * hai đầu. Không phải chuỗi / object ⇒ trả nguyên để schema báo lỗi.
 */
export const legacyFlowEdge = (raw: unknown): unknown => {
  if (typeof raw === "string") return { to: raw }
  if (!isRecord(raw)) return raw
  const out: Record<string, unknown> = { ...raw }
  for (const key of ["trigger", "guard"] as const) {
    if (!(key in out)) continue
    if (blank(out[key])) delete out[key]
    else if (typeof out[key] === "string") out[key] = (out[key] as string).trim()
  }
  return out
}

const legacyFlowEdges = (value: unknown): unknown => (Array.isArray(value) ? value.map(legacyFlowEdge) : value)

const withFlow = (screen: unknown): unknown => (isRecord(screen) && "flow_to" in screen ? { ...screen, flow_to: legacyFlowEdges(screen.flow_to) } : screen)

const FLOW_PATH = /^screens\[[^\]]*\]\.flow_to(\[[^\]]*\])?$/
const SCREEN_ELEMENT_PATH = /^screens\[[^\]]*\]$/

/**
 * Value của op/change tại `path` với `flow_to` ở dạng cạnh: `screens[id=…].flow_to` (cả mảng), `….flow_to[]` /
 * `….flow_to[to=…]` / `….flow_to[=…]` (một cạnh), `screens[id=…]` / `screens[]` (cả màn), `screens` (mọi màn), `$`/gốc
 * (cả Spine). Path khác ⇒ trả nguyên.
 */
export const normalizeFlowAt = (path: string, value: unknown): unknown => {
  if (FLOW_PATH.test(path)) return Array.isArray(value) ? legacyFlowEdges(value) : legacyFlowEdge(value)
  if (SCREEN_ELEMENT_PATH.test(path)) return withFlow(value)
  if (path === "screens") return Array.isArray(value) ? value.map(withFlow) : value
  if ((path === "$" || path === "") && isRecord(value) && Array.isArray(value.screens)) return { ...value, screens: value.screens.map(withFlow) }
  return value
}

/** Id màn đích của các cạnh (bỏ trùng, giữ thứ tự). */
export const flowTargets = (edges: readonly { to: string }[]): string[] => [...new Set(edges.map((e) => e.to))]

/** Màn đích của một phần tử `flow_to` còn chưa chuẩn hoá (op / output model có thể vẫn là chuỗi id). */
export const edgeTo = (edge: unknown): string => (typeof edge === "string" ? edge : isRecord(edge) && typeof edge.to === "string" ? edge.to : String(edge))
