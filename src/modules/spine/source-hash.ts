/**
 * source-hash.ts
 * ─────────────────────────────────────────────────────────────────
 * Hash `source_fields` của diagram (srs-spine.md §7.1) cho cờ đỏ `diagram_stale`.
 * Chỉ gồm field THẬT SỰ vẽ lên hình, sắp xếp theo `id` — sửa mô tả không làm hình "cũ".
 * T10 ghi `diagrams[].source_hash` bằng chính hàm này khi render.
 */

import { createHash } from "node:crypto"
import type { Diagram, Spine } from "./spine.types.js"

/** Giá trị `source_hash` nghĩa là chưa từng tính (fixture T02 dùng "TBD") — bỏ qua `diagram_stale`. */
export const UNHASHED_SOURCE_HASHES: ReadonlySet<string> = new Set(["", "TBD"])

const byId = <T extends { id: string }>(items: T[]): T[] => [...items].sort((a, b) => a.id.localeCompare(b.id))

export const sourceProjection = (spine: Spine, diagram: Pick<Diagram, "kind" | "owner_id">): unknown => {
  switch (diagram.kind) {
    case "context":
      return {
        project: { name: spine.project.name },
        actors: byId(spine.actors.filter((a) => a.kind !== "human")).map(({ id, name }) => ({ id, name }))
      }
    case "usecase":
      return {
        actors: byId(spine.actors).map(({ id, name, kind }) => ({ id, name, kind })),
        use_cases: byId(spine.use_cases).map(({ id, name, actor_ids, includes, extends: ext }) => ({
          id,
          name,
          actor_ids,
          includes,
          extends: ext
        }))
      }
    case "screen_flow":
      return {
        screens: byId(spine.screens).map(({ id, name, flow_to, is_popup, tabs }) => ({ id, name, flow_to, is_popup, tabs }))
      }
    case "erd":
      return { entities: byId(spine.entities).map(({ id, name, relations }) => ({ id, name, relations })) }
    case "screen_layout": {
      const screen = spine.screens.find((s) => s.id === diagram.owner_id)
      return {
        screen: screen ? { id: screen.id, name: screen.name } : null,
        functions: byId(spine.functions.filter((f) => f.screen_id === diagram.owner_id)).map(({ id, name, description }) => ({
          id,
          name,
          description
        }))
      }
    }
  }
}

/** JSON với key sắp xếp — hash không phụ thuộc thứ tự key. */
const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`
  }
  return JSON.stringify(value)
}

export const computeSourceHash = (spine: Spine, diagram: Pick<Diagram, "kind" | "owner_id">): string =>
  createHash("sha256").update(stableStringify(sourceProjection(spine, diagram))).digest("hex")
