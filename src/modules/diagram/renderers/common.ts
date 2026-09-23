/**
 * Tiện ích chung cho 5 renderer (assets/skills/action/plantuml-conventions).
 * Renderer là hàm THUẦN: cùng Spine ⇒ cùng text `.puml` (thứ tự tất định — mặc định theo id, use case
 * theo nhóm actor rồi id —, không timestamp).
 */

import type { Diagram, Spine } from "../../spine/spine.types.js"

export type DiagramKind = Diagram["kind"]

export interface RenderedPart {
  kind: DiagramKind
  section: string
  owner_kind: string | null
  owner_id: string | null
  puml: string
}

export type Renderer = (spine: Spine, ownerId?: string | null) => RenderedPart[]

/** So sánh chuỗi theo code unit — không phụ thuộc locale máy chạy. */
export const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

export const byId = <T extends { id: string }>(items: readonly T[]): T[] => [...items].sort((a, b) => compareIds(a.id, b.id))

/** Nhãn trong ngoặc kép: một dòng, không có `"` (PlantUML không escape được trong nhãn). */
export const label = (text: string): string => text.replace(/"/g, "'").replace(/\s+/g, " ").trim()

/** Alias: chỉ chữ, số, gạch dưới. Id Spine (A03, UC04, S07) giữ nguyên nên tên đổi không đổi alias. */
export const alias = (id: string): string => id.replace(/[^A-Za-z0-9_]/g, "_")

export const puml = (open: string, body: string[], close: string): string => `${[open, ...body, close].join("\n")}\n`
