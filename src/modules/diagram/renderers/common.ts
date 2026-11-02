/**
 * Tiện ích chung cho 5 renderer (assets/skills/action/plantuml-conventions).
 * Renderer là hàm THUẦN: cùng Spine ⇒ cùng nguồn hình (thứ tự tất định — mặc định theo id, use case
 * theo nhóm actor rồi id —, không timestamp). Hai engine (FLF-339): text `.puml` qua PlantUML server, hoặc SVG tự
 * dựng qua `Scene` của `shared/diagram/svg-scene.ts` (`svgPart`).
 */

import type { Diagram, DiagramFormat, Spine } from "../../spine/spine.types.js"
import { checkScene, type CheckOptions, type GeometryIssue } from "../../../shared/diagram/svg-geometry.js"
import type { Scene } from "../../../shared/diagram/svg-scene.js"
import type { RenderContext } from "../../../shared/diagram/erd-notation.js"
import type { DiagramLabels } from "./labels.js"

export type DiagramKind = Diagram["kind"]

export interface RenderedPart {
  kind: DiagramKind
  section: string
  owner_kind: string | null
  owner_id: string | null
  format: DiagramFormat
  source: string
  /** Chỉ `svg`: lỗi bố cục của `checkScene` — có ⇒ hình không được lưu (`render_status = error`). */
  issues?: GeometryIssue[]
}

/** `labels`: chữ máy trên hình (FLF-265 N1) — thiếu ⇒ tiếng Anh, đúng hình ghi vào `diagrams[]`. */
/** `context`: dữ liệu ngoài Spine mà hình cần (ký pháp ERD của dự án) — thiếu ⇒ mặc định. */
export type Renderer = (spine: Spine, ownerId?: string | null, labels?: DiagramLabels, context?: RenderContext) => RenderedPart[]

/** So sánh chuỗi theo code unit — không phụ thuộc locale máy chạy. */
export const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

export const byId = <T extends { id: string }>(items: readonly T[]): T[] => [...items].sort((a, b) => compareIds(a.id, b.id))

/** Nhãn trong ngoặc kép: một dòng, không có `"` (PlantUML không escape được trong nhãn). */
export const label = (text: string): string => text.replace(/"/g, "'").replace(/\s+/g, " ").trim()

/** Alias: chỉ chữ, số, gạch dưới. Id Spine (A03, UC04, S07) giữ nguyên nên tên đổi không đổi alias. */
export const alias = (id: string): string => id.replace(/[^A-Za-z0-9_]/g, "_")

export const puml = (open: string, body: string[], close: string): string => `${[open, ...body, close].join("\n")}\n`

/** Nội dung `<title>` của SVG do `Scene.toSvg(title)` sinh (đã giải escape); không có ⇒ null. */
export const svgTitleOf = (source: string): string | null => {
  const raw = /<title>([^<]*)<\/title>/.exec(source)?.[1]
  if (raw === undefined) return null
  return raw.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&")
}

/** Part `svg` từ một `Scene`: kiểm bố cục (luật 9) + markup. `allowBends` theo kind (`erd`, `class`, `screen_flow`, `state_machine`). */
export const svgPart = (scene: Scene, options: CheckOptions, meta: Omit<RenderedPart, "format" | "source" | "issues">, title?: string): RenderedPart => ({
  ...meta,
  format: "svg",
  source: scene.toSvg(title),
  issues: checkScene(scene, options)
})
