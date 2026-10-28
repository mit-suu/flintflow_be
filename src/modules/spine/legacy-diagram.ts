/**
 * legacy-diagram.ts
 * ─────────────────────────────────────────────────────────────────
 * FLF-339: `diagrams[]` đổi `puml` → `source` + `format` (`puml` | `svg`). Dữ liệu dạng cũ còn sống VĨNH VIỄN ở baseline
 * snapshot và lịch sử `changes` (không bao giờ viết lại), và ở doc `spines` chưa chạy `migrate:diagram-source`. Mọi
 * đường đọc / so sánh đi qua đây:
 * - `legacyDiagram`: preprocess phần tử `diagrams[]` trong `spineSchema` (đọc Mongo, baseline, change root).
 * - `normalizeDiagramAt`: value của op / change tại một path, để undo/revert change cũ so khớp phần tử mới.
 */

import { isRecord } from "./path-resolver.js"

/** `{ puml }` ⇒ `{ format: "puml", source }`. Luôn bỏ key `puml` (kể cả khi đã có `source`). Không phải object ⇒ trả nguyên. */
export const legacyDiagram = (raw: unknown): unknown => {
  if (!isRecord(raw) || ("format" in raw && !("puml" in raw))) return raw
  const { puml, ...rest } = raw
  return { ...rest, format: rest.format ?? "puml", source: rest.source ?? puml }
}

const ELEMENT_PATH = /^diagrams\[[^\]]*\]$/

const legacyDiagrams = (value: unknown): unknown => (Array.isArray(value) ? value.map(legacyDiagram) : value)

/**
 * Value của op/change tại `path` với phần tử `diagrams[]` đã chuyển dạng mới: `diagrams[id=…]` / `diagrams[]` (một phần tử),
 * `diagrams` (cả mảng), `$`/gốc (cả Spine). Path khác ⇒ trả nguyên.
 */
export const normalizeDiagramAt = (path: string, value: unknown): unknown => {
  if (ELEMENT_PATH.test(path)) return legacyDiagram(value)
  if (path === "diagrams") return legacyDiagrams(value)
  if ((path === "$" || path === "") && isRecord(value) && Array.isArray(value.diagrams)) return { ...value, diagrams: legacyDiagrams(value.diagrams) }
  return value
}
