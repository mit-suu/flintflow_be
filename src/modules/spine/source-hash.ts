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
import { screenActorMap, screenActorSets, sharedScreenIds } from "./screen-actors.js"
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
        // FLF-390: `parent_id` chỉ khi có — actor tổng quát không luồng riêng không vẽ; hash cũ của Spine không kế thừa giữ nguyên
        actors: byId(spine.actors).map(({ id, name, kind, flows_in, flows_out, parent_id }) => ({
          id,
          name,
          kind,
          flows_in: flows_in ?? [],
          flows_out: flows_out ?? [],
          ...(parent_id ? { parent_id } : {})
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
      // Actor đại diện của màn (`screen-actors.ts`): màn mất / có actor thì vẽ / không vẽ màn đó
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
    case "state_machine": {
      // Một hình = một entity (`owner_id`): tên entity, trạng thái và chuyển trạng thái đều hiện trên hình
      const entity = spine.entities.find((e) => e.id === diagram.owner_id)
      return {
        entity: entity?.name ?? null,
        states: (entity?.states ?? []).map(({ id, name, initial, final }) => ({ id, name, initial: initial ?? false, final: final ?? false })),
        transitions: (entity?.transitions ?? []).map(({ from, to, event, guard, action }) => ({ from, to, event, guard: guard ?? "", action: action ?? "" }))
      }
    }
    case "sequence": {
      // Một hình = một function (`owner_id`): tên function, message theo thứ tự, và tên + kind actor ở các đầu message
      const fn = spine.functions.find((f) => f.id === diagram.owner_id)
      const interactions = fn?.interactions ?? []
      const ends = new Set(interactions.flatMap((i) => [i.from, i.to]))
      return {
        function: fn ? { name: fn.name, screen: fn.screen_id !== null } : null,
        interactions: interactions.map(({ from, to, message, kind, flow, guard }) => ({ from, to, message, kind, flow, guard: guard ?? "" })),
        actors: byId(spine.actors.filter((a) => ends.has(a.id))).map(({ id, name, kind }) => ({ id, name, kind }))
      }
    }
    case "activity": {
      // FLF-390: một hình = một use case (`owner_id`): tên use case, nút (loại, chữ, làn), control flow + guard, tên actor ở làn
      const uc = spine.use_cases.find((u) => u.id === diagram.owner_id)
      const nodes = uc?.activity_nodes ?? []
      const lanes = new Set(nodes.flatMap((n) => (typeof n.lane === "string" ? [n.lane] : [])))
      return {
        use_case: uc?.name ?? null,
        nodes: nodes.map(({ id, kind, name, lane }) => ({ id, kind, name: name ?? "", lane: lane ?? "" })),
        flows: (uc?.activity_flows ?? []).map(({ from, to, guard }) => ({ from, to, guard: guard ?? "" })),
        actors: byId(spine.actors.filter((a) => lanes.has(a.id))).map(({ id, name }) => ({ id, name }))
      }
    }
    case "deployment": {
      // FLF-390: một hình cho cả hệ thống: nút (tên, loại, nút cha, artifact, component) và đường truyền thông + giao thức
      return {
        nodes: byId(spine.deployment_nodes ?? []).map(({ id, name, kind, parent_id, artifacts, components }) => ({ id, name, kind, parent_id, artifacts, components })),
        links: (spine.deployment_links ?? []).map(({ from, to, protocol }) => ({ from, to, protocol: protocol ?? "" }))
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
  // svg@2 (FLF-369): bộ xếp thử nhiều phương án (thứ tự hàng, actor hai bên) ⇒ hình svg@1 cũ thành stale, vẽ lại một lượt
  usecase: "svg@2",
  screen_flow: "svg@3",
  erd: "svg@1",
  class: "svg@1",
  state_machine: "svg@1",
  sequence: DEFAULT_DIAGRAM_ENGINE,
  activity: "svg@1",
  deployment: DEFAULT_DIAGRAM_ENGINE,
  screen_layout: DEFAULT_DIAGRAM_ENGINE
})

/**
 * Dữ liệu chỉ renderer SVG đọc thêm, ngoài `sourceProjection` (không đưa vào đó vì `originalDiagramHash` dùng chung hàm ấy:
 * ảnh gốc import đã lưu hash cũ sẽ báo `original_diagram_stale` giả). Use case chia hình theo feature: tên + thứ tự feature
 * và feature của các function mà use case tham chiếu; luồng màn (tách theo feature khi vượt ngưỡng) đọc feature + queue_order
 * của màn, tập màn dùng chung (nền `#7ACFF5` — đổi khi actor của màn hay phân cấp actor đổi) và actor người của từng màn (hình
 * quá lớn tách mỗi actor một hình, tiêu đề là tên actor).
 */
const renderedExtras = (spine: Spine, diagram: Pick<Diagram, "kind">, context: RenderContext): unknown => {
  // Ký pháp ERD nằm ở Project, không ở Spine: đổi ký pháp đổi hash ⇒ `diagram_stale` ⇒ vẽ lại
  if (diagram.kind === "erd") return { notation: context.erdNotation ?? DEFAULT_ERD_NOTATION }
  const features = byId(spine.features).map(({ id, name, order }) => ({ id, name, order }))
  if (diagram.kind === "screen_flow")
    return {
      screens: byId(spine.screens).map(({ id, feature_id, queue_order }) => ({ id, feature_id, queue_order })),
      // Tên feature không vẽ lên hình (chỉ thứ tự feature dùng khi tách) ⇒ đổi tên feature không làm hình cũ
      features: features.map(({ id, order }) => ({ id, order })),
      shared: [...sharedScreenIds(spine)].sort(),
      // Hình quá lớn tách theo actor người: tập actor của từng màn, tên (tiêu đề hình), actor tổng quát và thứ tự actor
      actor_sets: [...screenActorSets(spine)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      actors: spine.actors.filter((a) => a.kind === "human").map(({ id, name, parent_id }) => ({ id, name, parent_id: parent_id ?? null }))
    }
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
