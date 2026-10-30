/**
 * §2.2.1 Use Case Diagram — source_fields: `actors[].name/.kind/.parent_id` ·
 * `use_cases[].name/.actor_ids/.function_ids/.includes/.extends` · `functions[].feature_id` · `features[].name/.order`
 * (srs-spine §7.1). UML 2.5.1, dựng bằng SVG (hình học ở `usecase-layout.ts`, thuật toán ở
 * `docs/technical/usecase-diagram-layout.md`).
 *
 * CHIA HÌNH THEO FEATURE (không theo actor): feature của use case suy từ `function_ids` → `functions[].feature_id`
 * (nhiều feature ⇒ feature của function đầu tiên phân giải được trong `function_ids`). Use case chưa suy được feature
 * (chưa qua S-4.1, function chết) gom theo cụm quan hệ rồi theo actor người chính của cụm — tên nhóm là tên actor — và
 * đứng sau các feature. Nhóm quá `MAX_USE_CASES_PER_DIAGRAM` use case tách đều thành nhiều hình trong cùng nhóm. Phần
 * đầu tiên giữ id gốc của hình (`diagram.service.ts#assignIds`) nên baseline đã ký giữ được ảnh.
 *
 * Actor đúng như mô hình: một use case nối mọi actor trong `actor_ids`, actor tổng quát hiện nguyên trên hình (không bung
 * xuống actor lá), actor có con thì in nghiêng. Cạnh actor–use case là association (đường liền, không mũi tên). Actor
 * người KHÔNG nối vào use case mở rộng / được include khi quan hệ đó được vẽ trong cùng hình — actor đến với nó qua use
 * case gốc; actor `system`/`time` luôn giữ cạnh. Actor người mất hết cạnh thì giữ cạnh tới use case có id nhỏ nhất.
 *
 * include / extend chỉ vẽ khi cả hai đầu cùng hình, và là đoạn dọc giữa hai ellipse KỀ NHAU. Cột chỉ cho mỗi use case
 * hai hàng xóm, nên đồ thị quan hệ được tách thành các chuỗi (`relationChains`); một use case có > 2 quan hệ (hoặc vòng)
 * xuất hiện ở nhiều hình của cùng nhóm, mỗi hình giữ các chuỗi không chung use case. Hình không qua `checkScene` (đường
 * association quệt chữ actor) bị tách đôi tới khi sạch — luật 9 của conventions: không đạt bố cục thì tách hình.
 *
 * Generalization (`actors[].parent_id`, người ↔ người): khi có, thêm MỘT hình phân cấp actor (cuối danh sách, section
 * §2.1). Use case không có field cha trong Spine ⇒ không vẽ generalization giữa use case.
 */

import { checkScene } from "../../../shared/diagram/svg-geometry.js"
import { actorParents } from "../../spine/actor-generalization.js"
import type { ActorKind, Spine, UseCase } from "../../spine/spine.types.js"
import { systemName } from "../../spine/system-name.js"
import type { RenderedPart, Renderer } from "./common.js"
import { byId, compareIds, svgPart } from "./common.js"
import { DIAGRAM_LABELS, type DiagramLabels } from "./labels.js"
import { layoutActorHierarchy, layoutUseCaseDiagram, type Association, type DiagramActor, type Relation, type UseCaseDiagram } from "./usecase-layout.js"

export const MAX_USE_CASES_PER_DIAGRAM = 20

/** Trần cứng của một cụm quan hệ khi gom nhóm use case chưa có feature; cụm dài hơn bị cắt theo lô. */
export const MAX_CLUSTER_SPAN = MAX_USE_CASES_PER_DIAGRAM * 2

/** Section của hình phân cấp actor (§2.1) và của các hình use case (§2.2.1). */
export const ACTOR_HIERARCHY_SECTION = "fixed:2.1"
export const USE_CASE_SECTION = "fixed:2.2.1"

export type ActorKinds = ReadonlyMap<string, ActorKind>

const isHuman = (kinds: ActorKinds, actorId: string): boolean => kinds.get(actorId) === "human"
const clean = (text: string): string => text.replace(/\s+/g, " ").trim()

const chunks = <T>(items: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size))

/** Thành phần liên thông của đồ thị include/extend (vô hướng); cụm vượt trần cứng bị cắt theo lô. */
export const relationClusters = (useCases: readonly UseCase[]): UseCase[][] => {
  const sorted = byId(useCases)
  const known = new Map(sorted.map((u) => [u.id, u]))
  const neighbours = new Map<string, string[]>(sorted.map((u) => [u.id, []]))
  for (const uc of sorted) {
    for (const other of [...uc.includes, ...uc.extends]) {
      // Id chết là việc của cờ đỏ `dead_reference`; ở đây bỏ qua để đồ thị luôn hợp lệ.
      if (other === uc.id || !known.has(other)) continue
      neighbours.get(uc.id)!.push(other)
      neighbours.get(other)!.push(uc.id)
    }
  }

  const seen = new Set<string>()
  const clusters: UseCase[][] = []
  for (const root of sorted) {
    if (seen.has(root.id)) continue
    seen.add(root.id)
    const queue = [root.id]
    const members: UseCase[] = []
    while (queue.length > 0) {
      const id = queue.shift()!
      members.push(known.get(id)!)
      for (const next of [...new Set(neighbours.get(id) ?? [])].sort(compareIds)) {
        if (seen.has(next)) continue
        seen.add(next)
        queue.push(next)
      }
    }
    const ordered = byId(members)
    clusters.push(...(ordered.length > MAX_CLUSTER_SPAN ? chunks(ordered, MAX_USE_CASES_PER_DIAGRAM) : [ordered]))
  }
  return clusters
}

// ─── quan hệ include / extend → chuỗi ──────────────────────────────

interface RelationEdge extends Relation {
  id: string
}

/** Quan hệ include / extend giữa các use case trong `ids`, không tự trỏ, không trùng, sắp theo id. */
const relationEdges = (useCases: readonly UseCase[]): RelationEdge[] => {
  const ids = new Set(useCases.map((u) => u.id))
  const edges = new Map<string, RelationEdge>()
  const add = (from: string, to: string, kind: Relation["kind"]) => {
    if (from === to || !ids.has(from) || !ids.has(to)) return
    const id = `${kind}:${from}>${to}`
    edges.set(id, { id, from, to, kind })
  }
  for (const uc of useCases) {
    for (const included of uc.includes) add(uc.id, included, "include")
    for (const base of uc.extends) add(uc.id, base, "extend")
  }
  return [...edges.values()].sort((a, b) => compareIds(a.id, b.id))
}

/** Một chuỗi use case liên tiếp: `relations[i]` nối `nodes[i]` và `nodes[i + 1]`. Use case đơn lẻ = chuỗi một nút. */
export interface RelationChain {
  nodes: string[]
  relations: Relation[]
}

const asRelation = ({ from, to, kind }: RelationEdge): Relation => ({ from, to, kind })

/**
 * Tách đồ thị quan hệ thành các chuỗi đường đi đơn, rời nhau về cạnh (mỗi cạnh đúng một chuỗi). Bắt đầu từ đầu mút
 * (nút còn một cạnh) có id nhỏ nhất, đi tới hàng xóm id nhỏ nhất chưa có trong chuỗi — tất định.
 */
export const relationChains = (useCases: readonly UseCase[]): RelationChain[] => {
  const edges = relationEdges(useCases)
  const unused = new Set(edges.map((e) => e.id))
  const incident = (node: string): RelationEdge[] => edges.filter((e) => unused.has(e.id) && (e.from === node || e.to === node))
  const chains: RelationChain[] = []
  while (unused.size > 0) {
    const open = [...new Set(edges.filter((e) => unused.has(e.id)).flatMap((e) => [e.from, e.to]))].sort(compareIds)
    const start = open.find((n) => incident(n).length === 1) ?? open[0]
    const chain: RelationChain = { nodes: [start], relations: [] }
    for (;;) {
      const current = chain.nodes[chain.nodes.length - 1]
      const next = incident(current)
        .map((edge) => ({ edge, other: edge.from === current ? edge.to : edge.from }))
        .filter(({ other }) => !chain.nodes.includes(other))
        .sort((a, b) => compareIds(a.other, b.other) || compareIds(a.edge.id, b.edge.id))[0]
      if (!next) break
      unused.delete(next.edge.id)
      chain.nodes.push(next.other)
      chain.relations.push(asRelation(next.edge))
    }
    chains.push(chain)
  }
  return chains
}

/** Chuỗi nằm ≤ `size` nút mỗi đoạn; quan hệ băng qua ranh giới bị bỏ. */
const splitChain = (chain: RelationChain, size: number): RelationChain[] =>
  chain.nodes.length <= size
    ? [chain]
    : chunks(chain.nodes, size).map((nodes, i) => ({ nodes, relations: chain.relations.slice(i * size, i * size + nodes.length - 1) }))

// ─── nhóm theo feature ─────────────────────────────────────────────

interface UseCaseGroup {
  key: string
  /** Tên feature (hoặc tên actor chính của nhóm chưa có feature). */
  name: string
  useCases: UseCase[]
}

/** Feature của use case: function đầu tiên trong `function_ids` còn tồn tại và thuộc feature còn tồn tại. */
export const featureOfUseCase = (uc: UseCase, spine: Pick<Spine, "functions" | "features">): string | null => {
  const features = new Set(spine.features.map((f) => f.id))
  for (const fnId of uc.function_ids) {
    const fn = spine.functions.find((f) => f.id === fnId)
    if (fn && features.has(fn.feature_id)) return fn.feature_id
  }
  return null
}

/** Khoá nhóm cụm chưa có feature: actor NGƯỜI đầu tiên (actor chính đứng đầu `actor_ids`), không có ⇒ actor id nhỏ nhất. */
const clusterKey = (cluster: readonly UseCase[], kinds: ActorKinds): string => {
  const ids = cluster.flatMap((u) => u.actor_ids)
  return ids.find((id) => isHuman(kinds, id)) ?? [...new Set(ids)].sort(compareIds)[0] ?? "~"
}

const groupUseCases = (spine: Spine, kinds: ActorKinds, labels: DiagramLabels): UseCaseGroup[] => {
  const byFeature = new Map<string, UseCase[]>()
  const unassigned: UseCase[] = []
  for (const uc of byId(spine.use_cases)) {
    const feature = featureOfUseCase(uc, spine)
    if (feature === null) unassigned.push(uc)
    else byFeature.set(feature, [...(byFeature.get(feature) ?? []), uc])
  }
  const groups: UseCaseGroup[] = [...spine.features]
    .sort((a, b) => a.order - b.order || compareIds(a.id, b.id))
    .filter((f) => byFeature.has(f.id))
    .map((f) => ({ key: f.id, name: clean(f.name) || f.id, useCases: byFeature.get(f.id)! }))

  const rest = new Map<string, UseCase[]>()
  for (const cluster of relationClusters(unassigned)) {
    const key = clusterKey(cluster, kinds)
    rest.set(key, [...(rest.get(key) ?? []), ...cluster])
  }
  const actorName = new Map(spine.actors.map((a) => [a.id, a.name]))
  const rank = (key: string): number => (isHuman(kinds, key) ? 0 : 1)
  const keys = [...rest.keys()].sort((a, b) => rank(a) - rank(b) || compareIds(a, b))
  for (const key of keys) groups.push({ key, name: clean(actorName.get(key) ?? "") || (key === "~" ? labels.otherGroup : key), useCases: byId(rest.get(key)!) })
  return groups
}

// ─── chia một nhóm thành các hình ──────────────────────────────────

export interface UseCasePart {
  groupKey: string
  /** Tên nhóm kèm `(i/n)` khi nhóm tách nhiều hình. */
  name: string
  /** Thứ tự dọc trên hình: use case liên quan kề nhau. */
  useCases: UseCase[]
  relations: Relation[]
  associations: Association[]
}

/** Actor chính của use case — dùng xếp các use case cùng actor gần nhau, ít đường association chéo nhau. */
const primaryActor = (uc: UseCase, kinds: ActorKinds): string => uc.actor_ids.find((id) => isHuman(kinds, id)) ?? uc.actor_ids[0] ?? "~"

/** Cạnh actor–use case của một hình, theo luật bỏ cạnh actor người ở use case phụ thuộc. */
const associationsOf = (useCases: readonly UseCase[], relations: readonly Relation[], kinds: ActorKinds): Association[] => {
  const dependent = new Set([...relations.filter((r) => r.kind === "include").map((r) => r.to), ...relations.filter((r) => r.kind === "extend").map((r) => r.from)])
  const kept: Association[] = []
  const dropped = new Map<string, string[]>()
  for (const uc of useCases) {
    for (const actorId of [...new Set(uc.actor_ids)].sort(compareIds)) {
      if (!kinds.has(actorId)) continue
      if (isHuman(kinds, actorId) && dependent.has(uc.id)) dropped.set(actorId, [...(dropped.get(actorId) ?? []), uc.id])
      else kept.push({ actorId, useCaseId: uc.id })
    }
  }
  // Actor người không còn cạnh nào ⇒ giữ cạnh tới use case id nhỏ nhất, nếu không actor biến mất khỏi hình
  for (const [actorId, ids] of dropped) {
    if (!kept.some((k) => k.actorId === actorId)) kept.push({ actorId, useCaseId: [...ids].sort(compareIds)[0] })
  }
  const order = new Map(useCases.map((u, i) => [u.id, i]))
  return kept.sort((a, b) => order.get(a.useCaseId)! - order.get(b.useCaseId)! || compareIds(a.actorId, b.actorId))
}

/** Hình có đạt bố cục không (`checkScene` sạch)? Không đạt ⇒ `partsOfGroup` tách đôi (luật 9: không đạt thì tách hình). */
type Fits = (part: UseCasePart) => boolean

const partsOfGroup = (group: UseCaseGroup, kinds: ActorKinds, fits: Fits): UseCasePart[] => {
  const known = new Map(group.useCases.map((u) => [u.id, u]))
  const chains = relationChains(group.useCases).flatMap((c) => splitChain(c, MAX_USE_CASES_PER_DIAGRAM))
  // Mỗi lớp là một hình: các chuỗi trong lớp không chung use case (use case xuất hiện một lần trên một hình)
  const layers: RelationChain[][] = []
  for (const chain of chains) {
    const layer = layers.find((l) => l.every((c) => c.nodes.every((n) => !chain.nodes.includes(n))))
    if (layer) layer.push(chain)
    else layers.push([chain])
  }
  const inChain = new Set(chains.flatMap((c) => c.nodes))
  const singles: RelationChain[] = group.useCases.filter((u) => !inChain.has(u.id)).map((u) => ({ nodes: [u.id], relations: [] }))
  if (layers.length === 0) layers.push([])
  layers[0].push(...singles)

  const blockKey = (c: RelationChain): [string, string] => {
    const first = [...c.nodes].sort(compareIds)[0]
    return [primaryActor(known.get(first)!, kinds), first]
  }
  const ordered = (blocks: RelationChain[]): RelationChain[] =>
    [...blocks].sort((a, b) => {
      const [ka, ia] = blockKey(a)
      const [kb, ib] = blockKey(b)
      return compareIds(ka, kb) || compareIds(ia, ib)
    })

  const raw: RelationChain[][] = []
  for (const layer of layers) {
    const blocks = ordered(layer)
    const total = blocks.reduce((n, c) => n + c.nodes.length, 0)
    // Quá trần ⇒ chia đều, không cắt giữa chuỗi quan hệ
    const target = Math.ceil(total / Math.ceil(total / MAX_USE_CASES_PER_DIAGRAM))
    let current: RelationChain[] = []
    let size = 0
    for (const block of blocks) {
      if (current.length > 0 && size + block.nodes.length > target) {
        raw.push(current)
        current = []
        size = 0
      }
      current.push(block)
      size += block.nodes.length
    }
    if (current.length > 0) raw.push(current)
  }

  const make = (blocks: RelationChain[], name: string): UseCasePart => {
    const useCases = blocks.flatMap((b) => b.nodes).map((id) => known.get(id)!)
    const relations = blocks.flatMap((b) => b.relations)
    return { groupKey: group.key, name, useCases, relations, associations: associationsOf(useCases, relations, kinds) }
  }
  /** Tách đôi tới khi vừa; một chuỗi dài bị cắt giữa (quan hệ ở chỗ cắt không vẽ), một use case đơn thì dừng. */
  const refine = (blocks: RelationChain[]): RelationChain[][] => {
    if (fits(make(blocks, group.name))) return [blocks]
    if (blocks.length > 1) {
      const half = Math.ceil(blocks.length / 2)
      return [...refine(blocks.slice(0, half)), ...refine(blocks.slice(half))]
    }
    const [only] = blocks
    if (only.nodes.length < 2) return [blocks]
    return splitChain(only, Math.ceil(only.nodes.length / 2)).flatMap((piece) => refine([piece]))
  }
  const final = raw.flatMap(refine)
  return final.map((blocks, i) => make(blocks, final.length > 1 ? `${group.name} (${i + 1}/${final.length})` : group.name))
}

/** Mọi hình use case của Spine theo thứ tự xuất hiện trong tài liệu (feature theo `order`, rồi nhóm chưa có feature). */
export const partitionUseCases = (spine: Spine, labels: DiagramLabels = DIAGRAM_LABELS.en, fits: Fits = () => true): UseCasePart[] => {
  const kinds: ActorKinds = new Map(spine.actors.map((a) => [a.id, a.kind]))
  return groupUseCases(spine, kinds, labels).flatMap((g) => partsOfGroup(g, kinds, fits))
}

// ─── renderer ──────────────────────────────────────────────────────

const meta = (section: string): Pick<RenderedPart, "kind" | "section" | "owner_kind" | "owner_id"> => ({ kind: "usecase", section, owner_kind: null, owner_id: null })

export const renderUseCase: Renderer = (spine, _ownerId, labels = DIAGRAM_LABELS.en) => {
  const actors = new Map(spine.actors.map((a) => [a.id, a]))
  const parents = actorParents(spine.actors)
  const abstract = new Set(parents.values())
  const system = clean(systemName(spine.project)) || labels.system
  const actorOf = (id: string): DiagramActor => {
    const a = actors.get(id)!
    return { id: a.id, name: clean(a.name), kind: a.kind, abstract: abstract.has(a.id) }
  }

  const diagramOf = (part: UseCasePart): UseCaseDiagram => ({
    system,
    rows: part.useCases.map((u) => ({ id: u.id, name: clean(u.name) })),
    actors: [...new Set(part.associations.map((a) => a.actorId))].sort(compareIds).map(actorOf),
    associations: part.associations,
    relations: part.relations
  })
  const fits: Fits = (part) => checkScene(layoutUseCaseDiagram(diagramOf(part)), { allowBends: false }).length === 0

  const out: RenderedPart[] = partitionUseCases(spine, labels, fits).map((part) =>
    svgPart(layoutUseCaseDiagram(diagramOf(part)), { allowBends: false }, meta(USE_CASE_SECTION), labels.useCasesTitle(part.name))
  )

  if (parents.size > 0) {
    const humans = byId(spine.actors.filter((a) => a.kind === "human")).map((a) => ({ id: a.id, name: clean(a.name), abstract: abstract.has(a.id) }))
    out.push(svgPart(layoutActorHierarchy(humans, parents), { allowBends: false }, meta(ACTOR_HIERARCHY_SECTION), labels.actorHierarchyTitle))
  }
  return out
}
