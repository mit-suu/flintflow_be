/**
 * source-hash.ts
 * ─────────────────────────────────────────────────────────────────
 * Hash `source_fields` của diagram (srs-spine.md §7.1) cho cờ đỏ `diagram_stale`.
 * Chỉ gồm field THẬT SỰ vẽ lên hình, sắp xếp theo `id` — sửa mô tả không làm hình "cũ".
 * T10 ghi `diagrams[].source_hash` bằng `renderedDiagramHash` khi render.
 *
 * Hai hash (FLF-339):
 * - `computeSourceHash`: hash DỮ LIỆU vẽ lên hình — `originalDiagramHash` (ảnh gốc import), `impact.service` dùng.
 * - `renderedDiagramHash`: hash của HÌNH đã vẽ = dữ liệu + engine/ký pháp của kind. Đổi renderer (vd PlantUML → SVG) chỉ
 *   cần tăng engine trong `DIAGRAM_ENGINES` ⇒ hình cũ `diagram_stale` và được vẽ lại, còn ảnh gốc import không bị
 *   `original_diagram_stale` giả. Engine mặc định trả đúng `computeSourceHash` ⇒ hình đang có không stale khi deploy.
 */

import { createHash } from "node:crypto"
import type { Diagram, DiagramKind, Spine } from "./spine.types.js"
import { entitiesOfFeature } from "./entity-features.js"
import { screenActorMap } from "./screen-actors.js"
import { systemName } from "./system-name.js"
import { DEFAULT_ERD_NOTATION, type RenderContext } from "../../shared/diagram/erd-notation.js"

/** Giá trị `source_hash` nghĩa là chưa từng tính (fixture T02 dùng "TBD") — bỏ qua `diagram_stale`. */
export const UNHASHED_SOURCE_HASHES: ReadonlySet<string> = new Set(["", "TBD"])

const byId = <T extends { id: string }>(items: T[]): T[] => [...items].sort((a, b) => a.id.localeCompare(b.id))

export const sourceProjection = (spine: Spine, diagram: Pick<Diagram, "kind" | "owner_id">): unknown => {
  switch (diagram.kind) {
    case "context":
      return {
        project: { name: systemName(spine.project) },
        actors: byId(spine.actors).map(({ id, name, kind, flows_in, flows_out }) => ({
          id,
          name,
          kind,
          flows_in: flows_in ?? [],
          flows_out: flows_out ?? []
        })),
        use_cases: byId(spine.use_cases).map(({ id, name, actor_ids }) => ({ id, name, actor_ids }))
      }
    case "usecase":
      return {
        // Boundary vẽ `system_name ?? project.name` nhưng chỉ hash khi đã đặt `system_name` (undefined bị bỏ khỏi
        // chuỗi hash) — hình cũ không bị `diagram_stale` hàng loạt; đổi `project.name` vẫn không làm hình cũ như trước.
        system_name: spine.project.system_name?.trim() || undefined,
        // `parent_id` vắng ⇒ undefined ⇒ bị bỏ khỏi chuỗi hash: hình cũ không có generalization không bị stale.
        actors: byId(spine.actors).map(({ id, name, kind, parent_id }) => ({ id, name, kind, parent_id: parent_id ?? undefined })),
        use_cases: byId(spine.use_cases).map(({ id, name, actor_ids, includes, extends: ext }) => ({
          id,
          name,
          actor_ids,
          includes,
          extends: ext
        }))
      }
    case "screen_flow":
      // Làn của màn = actor theo mô hình actor – use case (`screen-actors.ts`): đổi actor của màn cũng làm hình cũ
      return {
        screens: byId(spine.screens).map(({ id, name, flow_to, is_popup, tabs }) => ({ id, name, flow_to, is_popup, tabs })),
        actors: byId(spine.actors.filter((a) => a.kind === "human")).map(({ id, name }) => ({ id, name })),
        screen_actors: [...screenActorMap(spine)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      }
    case "erd":
      return {
        entities: byId(spine.entities).map(({ id, name, relations, relation_verbs, relation_cardinality, relation_optional, attributes }) => ({
          id,
          name,
          // ERD vẽ khoá (PK / FK) và tên thuộc tính; vắng / rỗng ⇒ undefined (bị bỏ khỏi chuỗi hash): hình cũ không stale
          attributes: attributes?.length ? attributes.map((a) => ({ name: a.name, kind: a.kind })) : undefined,
          relations,
          relation_verbs: relation_verbs ?? {},
          relation_cardinality: relation_cardinality ?? {},
          relation_optional: relation_optional ?? []
        }))
      }
    case "class": {
      // Một hình = một feature (`owner_id`). Chỉ quan hệ giữa các entity cùng hình được vẽ
      const members = entitiesOfFeature(spine, diagram.owner_id)
      const ids = new Set(members.map((e) => e.id))
      return {
        feature: spine.features.find((f) => f.id === diagram.owner_id)?.name ?? null,
        entities: members.map(({ id, name, attributes, relations, relation_verbs, relation_cardinality, relation_optional }) => ({
          id,
          name,
          attributes: (attributes ?? []).map(({ name: n, kind, required }) => ({ name: n, kind, required })),
          relations: relations.filter((r) => ids.has(r)),
          relation_verbs: relation_verbs ?? {},
          relation_cardinality: relation_cardinality ?? {},
          relation_optional: relation_optional ?? []
        }))
      }
    }
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

/** JSON với key sắp xếp — hash không phụ thuộc thứ tự key. Lớp bản dịch (FLF-265) cũng băm chữ gốc bằng hàm này. */
export const stableStringify = (value: unknown): string => {
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

/** Engine của hình đã vẽ — hash bằng `computeSourceHash` để hình đang có giữ nguyên hash. */
export const DEFAULT_DIAGRAM_ENGINE = "plantuml@1"

/**
 * Engine / phiên bản ký pháp từng kind. Kind chuyển sang SVG tự dựng (FLF-322…) hoặc đổi ký pháp thì đổi giá trị ở đây
 * (vd `"svg@1"`) — mọi hình đã vẽ của kind đó thành `diagram_stale` và được vẽ lại bằng renderer mới.
 */
export const DIAGRAM_ENGINES: Readonly<Record<DiagramKind, string>> = Object.freeze({
  context: DEFAULT_DIAGRAM_ENGINE,
  usecase: "svg@1",
  screen_flow: "svg@1",
  erd: "svg@1",
  class: "svg@1",
  screen_layout: DEFAULT_DIAGRAM_ENGINE
})

/**
 * Dữ liệu chỉ renderer SVG đọc thêm, ngoài `sourceProjection` (không đưa vào đó vì `originalDiagramHash` dùng chung hàm ấy:
 * ảnh gốc import đã lưu hash cũ sẽ báo `original_diagram_stale` giả). Use case chia hình theo feature: tên + thứ tự feature
 * và feature của các function mà use case tham chiếu; luồng màn chia hình theo feature của màn và xếp màn theo queue_order.
 */
const renderedExtras = (spine: Spine, diagram: Pick<Diagram, "kind">, context: RenderContext): unknown => {
  // Ký pháp ERD nằm ở Project, không ở Spine: đổi ký pháp đổi hash ⇒ `diagram_stale` ⇒ vẽ lại
  if (diagram.kind === "erd") return { notation: context.erdNotation ?? DEFAULT_ERD_NOTATION }
  const features = byId(spine.features).map(({ id, name, order }) => ({ id, name, order }))
  if (diagram.kind === "screen_flow") return { screens: byId(spine.screens).map(({ id, feature_id, queue_order }) => ({ id, feature_id, queue_order })), features }
  if (diagram.kind !== "usecase") return undefined
  const referenced = new Set(spine.use_cases.flatMap((u) => u.function_ids))
  return {
    function_ids: byId(spine.use_cases).map(({ id, function_ids }) => ({ id, function_ids })),
    functions: byId(spine.functions.filter((f) => referenced.has(f.id))).map(({ id, feature_id }) => ({ id, feature_id })),
    features
  }
}

/** Hash ghi vào `diagrams[].source_hash` và so ở cờ `diagram_stale` — xem đầu file. */
export const renderedDiagramHash = (
  spine: Spine,
  diagram: Pick<Diagram, "kind" | "owner_id">,
  engines: Readonly<Record<DiagramKind, string>> = DIAGRAM_ENGINES,
  context: RenderContext = {}
): string => {
  const engine = engines[diagram.kind] ?? DEFAULT_DIAGRAM_ENGINE
  if (engine === DEFAULT_DIAGRAM_ENGINE) return computeSourceHash(spine, diagram)
  return createHash("sha256").update(stableStringify({ engine, projection: sourceProjection(spine, diagram), extras: renderedExtras(spine, diagram, context) })).digest("hex")
}
