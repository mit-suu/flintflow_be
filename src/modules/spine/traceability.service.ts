/**
 * traceability.service.ts
 * ─────────────────────────────────────────────────────────────────
 * Traceability map READ-ONLY (UC 6.7, srs-spine.md §9): "thực thể này liên quan tới những gì".
 * Đồ thị dựng từ chính `reference_fields[]` (§4.1) — KHÔNG có bảng quan hệ chép tay thứ hai, và
 * KHÔNG phải "source link về tài liệu upload" như module specification cũ
 * (khái niệm cũ, C4 trong audit; file cũ xoá ở T21).
 *
 * Chỉ 8 loại thực thể có mặt trong `traceabilityEntitySchema` (pipeline.dto.ts) thành node. `roles[]`
 * và `permissions[]` không phải node — chúng là **cầu** nối actor ↔ screen (ma trận phân quyền §3.1.3),
 * nên được gộp thành một cạnh `actor → screen` field `permissions`.
 *
 * Bán kính 2 bước (`DEFAULT_DEPTH`) và trần `MAX_NODES`: đủ để thấy actor → use case → function/screen
 * mà không kéo cả Spine về khi người dùng bấm vào một actor có 16 use case.
 */

import { iterateReferences } from "./reference-fields.js"
import type { Spine } from "./spine.types.js"

export type TraceEntity = "actor" | "use_case" | "function" | "screen" | "entity" | "nfr" | "feature" | "business_rule"

export interface TraceNode {
  kind: TraceEntity
  id: string
  label: string
}

export interface TraceEdge {
  from: string
  to: string
  /** Tên field đã tạo ra cạnh (`actor_ids`, `flow_to`, `permissions`…). */
  field: string
}

export interface TraceGraph {
  nodes: TraceNode[]
  edges: TraceEdge[]
}

export interface TraceQuery {
  entity: TraceEntity
  id: string
}

export interface TraceOptions {
  /** Số bước lan từ node gốc. */
  depth?: number
}

/** Actor → use case → function/screen là 2 bước; đủ cho bản đồ một màn hình. */
export const DEFAULT_DEPTH = 2
export const MAX_NODES = 200

/** Collection Spine → loại node; collection không có ở đây không thành node. */
const KIND_OF_COLLECTION: Readonly<Record<string, TraceEntity>> = Object.freeze({
  actors: "actor",
  use_cases: "use_case",
  functions: "function",
  screens: "screen",
  entities: "entity",
  nfrs: "nfr",
  features: "feature",
  business_rules: "business_rule"
})

const COLLECTION_OF_KIND: Readonly<Record<TraceEntity, string>> = Object.freeze({
  actor: "actors",
  use_case: "use_cases",
  function: "functions",
  screen: "screens",
  entity: "entities",
  nfr: "nfrs",
  feature: "features",
  business_rule: "business_rules"
})

/** `use_cases[id=UC01]` → collection + id của phần tử giữ khoá. */
const OWNER_RE = /^([a-z_]+)\[id=([^\]]+)\]$/

/** `use_cases[].actor_ids[]` → `actor_ids`; `screens[].feature_id` → `feature_id`. */
const fieldNameOf = (referenceFieldPath: string): string =>
  referenceFieldPath.split(".").pop()!.replace(/\[\]$/, "")

interface NodeRef {
  kind: TraceEntity
  id: string
}

const labelOf = (spine: Spine, kind: TraceEntity, id: string): string => {
  const list = (spine as unknown as Record<string, { id: string; name?: string; statement?: string }[]>)[COLLECTION_OF_KIND[kind]]
  const element = Array.isArray(list) ? list.find((x) => x.id === id) : undefined
  return element?.name ?? element?.statement ?? id
}

/** Validation id (`FN001-V1`) → function sở hữu nó; `business_rules[].source_validation_ids` đi qua đây. */
const functionOfValidation = (spine: Spine, validationId: string): string | null =>
  spine.functions.find((f) => f.validations.some((v) => v.id === validationId))?.id ?? null

const key = (ref: NodeRef): string => `${ref.kind}:${ref.id}`

/** Cạnh vô hướng khi duyệt, có hướng khi trả ra (giữ đúng chiều field trỏ). */
interface Link {
  from: NodeRef
  to: NodeRef
  field: string
}

/**
 * Toàn bộ cạnh của Spine, dựng từ `reference_fields[]` + cầu roles/permissions.
 * Hàm thuần; `trace` chỉ lọc lại quanh node gốc.
 */
export const buildTraceLinks = (spine: Spine): Link[] => {
  const links: Link[] = []
  const seen = new Set<string>()

  const push = (from: NodeRef | null, to: NodeRef | null, field: string): void => {
    if (!from || !to || (from.kind === to.kind && from.id === to.id)) return
    const id = `${key(from)}→${key(to)}@${field}`
    if (seen.has(id)) return
    seen.add(id)
    links.push({ from, to, field })
  }

  for (const hit of iterateReferences(spine)) {
    const owner = OWNER_RE.exec(hit.ownerPath)
    if (!owner) continue
    const [, collection, ownerId] = owner
    const fromKind = KIND_OF_COLLECTION[collection]
    if (!fromKind) continue
    const field = fieldNameOf(hit.field.path)

    if (hit.target === "validations") {
      const functionId = functionOfValidation(spine, hit.targetId)
      push({ kind: fromKind, id: ownerId }, functionId ? { kind: "function", id: functionId } : null, field)
      continue
    }
    const toKind = KIND_OF_COLLECTION[hit.target]
    if (!toKind) continue
    push({ kind: fromKind, id: ownerId }, { kind: toKind, id: hit.targetId }, field)
  }

  // Cầu phân quyền: actor —(roles[].actor_id + permissions[].role_id/screen_id)→ screen
  const actorOfRole = new Map(spine.roles.map((r) => [r.id, r.actor_id]))
  for (const permission of spine.permissions) {
    const actorId = actorOfRole.get(permission.role_id) ?? null
    if (actorId === null) continue
    push({ kind: "actor", id: actorId }, { kind: "screen", id: permission.screen_id }, "permissions")
  }

  return links
}

/**
 * Bản đồ quanh một thực thể: node gốc + hàng xóm trong `depth` bước. Read-only, không ghi gì.
 * Thực thể không tồn tại ⇒ đồ thị rỗng (không 404: UI chỉ hiện "không có liên kết").
 */
export const trace = (spine: Spine, query: TraceQuery, options: TraceOptions = {}): TraceGraph => {
  const root: NodeRef = { kind: query.entity, id: query.id }
  const exists = (ref: NodeRef): boolean => {
    const list = (spine as unknown as Record<string, { id: string }[]>)[COLLECTION_OF_KIND[ref.kind]]
    return Array.isArray(list) && list.some((x) => x.id === ref.id)
  }
  if (!exists(root)) return { nodes: [], edges: [] }

  const links = buildTraceLinks(spine)
  const neighbours = new Map<string, Link[]>()
  for (const link of links) {
    for (const side of [link.from, link.to]) {
      const list = neighbours.get(key(side))
      if (list) list.push(link)
      else neighbours.set(key(side), [link])
    }
  }

  const depth = options.depth ?? DEFAULT_DEPTH
  const visited = new Map<string, NodeRef>([[key(root), root]])
  const edges = new Map<string, TraceEdge>()
  let frontier: NodeRef[] = [root]

  for (let step = 0; step < depth && frontier.length > 0 && visited.size < MAX_NODES; step++) {
    const next: NodeRef[] = []
    for (const node of frontier) {
      for (const link of neighbours.get(key(node)) ?? []) {
        const other = key(link.from) === key(node) ? link.to : link.from
        edges.set(`${key(link.from)}→${key(link.to)}@${link.field}`, { from: link.from.id, to: link.to.id, field: link.field })
        if (visited.has(key(other)) || visited.size >= MAX_NODES) continue
        visited.set(key(other), other)
        next.push(other)
      }
    }
    frontier = next
  }

  // Cạnh chỉ giữ khi cả hai đầu nằm trong tập node đã lấy (tránh cạnh trỏ ra ngoài bản đồ)
  const nodeIds = new Set([...visited.values()].map((n) => n.id))
  return {
    nodes: [...visited.values()].map((ref) => ({ kind: ref.kind, id: ref.id, label: labelOf(spine, ref.kind, ref.id) })),
    edges: [...edges.values()].filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to))
  }
}
