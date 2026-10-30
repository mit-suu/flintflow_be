/**
 * §3.1.5 ERD — source_fields: `entities[].name/.relations/.relation_verbs/.relation_cardinality/.relation_optional`
 * (srs-spine §7.1) + ký pháp của dự án (`Project.erdNotation`, ngoài Spine — truyền qua `RenderContext`).
 * Dựng bằng SVG, ba ký pháp Chen / Crow's foot / IDEF1X trên một bộ xếp lưới + đi đường vuông góc dùng chung
 * (`erd-layout.ts`). Thuộc tính chưa có trong Spine nên chưa vẽ.
 *
 * Cả hệ thống một hình; quá `MAX_ENTITIES_PER_DIAGRAM` entity thì tách theo thành phần liên thông (xếp các thành phần nhỏ
 * vào chung một hình), thành phần quá lớn cắt theo thứ tự duyệt rộng; quan hệ băng qua chỗ cắt không vẽ. Hình không qua
 * `checkScene` tách đôi tiếp. Phần đầu giữ id gốc của hình (`diagram.service.ts#assignIds`).
 */

import { checkScene } from "../../../shared/diagram/svg-geometry.js"
import { DEFAULT_ERD_NOTATION, type ErdNotation } from "../../../shared/diagram/erd-notation.js"
import { Scene } from "../../../shared/diagram/svg-scene.js"
import type { Entity, Spine } from "../../spine/spine.types.js"
import type { RenderedPart, Renderer } from "./common.js"
import { byId, compareIds, svgPart } from "./common.js"
import { layoutErd, type ErdAttribute, type ErdDiagram, type ErdRelationInput } from "./erd-layout.js"
import { DIAGRAM_LABELS, type DiagramLabels } from "./labels.js"

export const MAX_ENTITIES_PER_DIAGRAM = 25
export const ERD_SECTION = "fixed:3.1.5"

/** Động từ khi quan hệ chưa có `relation_verbs` — nhãn không bao giờ trống (bản tiếng Anh — `labels.ts`). */
export const DEFAULT_RELATION_VERB = DIAGRAM_LABELS.en.relationVerb

export const relationVerb = (entity: Pick<Entity, "relation_verbs">, targetId: string, fallback: string = DEFAULT_RELATION_VERB): string =>
  entity.relation_verbs?.[targetId]?.trim() || fallback

/** Cặp cha → con của một quan hệ — đủ cho các hàm chia hình (ERD và class diagram dùng chung). */
export interface Link {
  from: string
  to: string
}

const relationsOf = (entities: readonly Entity[], labels: DiagramLabels): ErdRelationInput[] => {
  const ids = new Set(entities.map((e) => e.id))
  return entities.flatMap((e) =>
    [...new Set(e.relations)]
      .sort(compareIds)
      .filter((target) => ids.has(target))
      .map((target): ErdRelationInput => ({
        id: `${e.id}>${target}`,
        from: e.id,
        to: target,
        verb: relationVerb(e, target, labels.relationVerb),
        cardinality: e.relation_cardinality?.[target] ?? "N",
        optional: e.relation_optional?.includes(target) ?? false
      }))
  )
}

/** Thứ tự duyệt rộng của `ids` theo quan hệ (thành phần liên thông liền nhau) — chỗ cắt ít đường nhất có thể. */
export const traversalOrder = (ids: readonly string[], relations: readonly Link[]): string[] => {
  const adjacent = new Map(ids.map((id): [string, string[]] => [id, []]))
  for (const r of relations) {
    adjacent.get(r.from)?.push(r.to)
    adjacent.get(r.to)?.push(r.from)
  }
  const seen = new Set<string>()
  const order: string[] = []
  for (const start of ids) {
    if (seen.has(start)) continue
    seen.add(start)
    const queue = [start]
    for (let i = 0; i < queue.length; i++) {
      order.push(queue[i])
      for (const n of [...new Set(adjacent.get(queue[i]) ?? [])].sort(compareIds)) {
        if (seen.has(n) || !adjacent.has(n)) continue
        seen.add(n)
        queue.push(n)
      }
    }
  }
  return order
}

const components = (ids: readonly string[], relations: readonly Link[]): string[][] => {
  const order = traversalOrder(ids, relations)
  const root = new Map<string, string>()
  const find = (id: string): string => {
    let cur = id
    while (root.get(cur) !== cur) cur = root.get(cur)!
    return cur
  }
  for (const id of order) root.set(id, id)
  for (const r of relations) root.set(find(r.from), find(r.to))
  const groups = new Map<string, string[]>()
  for (const id of order) groups.set(find(id), [...(groups.get(find(id)) ?? []), id])
  return [...groups.values()]
}

/** Chia `ids` (đã theo thứ tự duyệt) thành các nhóm ≤ `limit`: thành phần nhỏ gộp theo first-fit, thành phần lớn cắt liên tiếp. */
export const groupEntities = (ids: readonly string[], relations: readonly Link[], limit: number): string[][] => {
  if (ids.length <= limit) return [[...ids]]
  const bins: string[][] = []
  const open: string[][] = []
  const comps = components(ids, relations).sort((a, b) => b.length - a.length || compareIds(a[0], b[0]))
  for (const comp of comps) {
    if (comp.length > limit) {
      for (let i = 0; i < comp.length; i += limit) {
        const chunk = comp.slice(i, i + limit)
        bins.push(chunk)
        if (chunk.length < limit) open.push(chunk)
      }
      continue
    }
    const bin = open.find((b) => b.length + comp.length <= limit)
    if (bin) bin.push(...comp)
    else {
      const fresh = [...comp]
      open.push(fresh)
      bins.push(fresh)
    }
  }
  return bins.map((b) => ids.filter((id) => b.includes(id)))
}

/** Khoá thuộc tính ⇒ PK, tham chiếu ⇒ FK; tên thuộc tính theo Spine. */
const erdAttributes = (e: Entity): ErdAttribute[] => (e.attributes ?? []).map((a) => ({ name: a.name, pk: a.kind === "key", fk: a.kind === "reference" }))

export interface ErdPart {
  title: string
  scene: Scene | null
  diagram: ErdDiagram
}

/** Mọi hình ERD của Spine theo thứ tự trong tài liệu. */
export const partitionErd = (spine: Spine, notation: ErdNotation = DEFAULT_ERD_NOTATION, labels: DiagramLabels = DIAGRAM_LABELS.en): ErdPart[] => {
  const entities = byId(spine.entities)
  const relations = relationsOf(entities, labels)
  const diagramOf = (ids: readonly string[]): ErdDiagram => {
    const set = new Set(ids)
    return {
      notation,
      entities: entities.filter((e) => set.has(e.id)).map((e) => ({ id: e.id, name: e.name, attributes: erdAttributes(e) })),
      relations: relations.filter((r) => set.has(r.from) && set.has(r.to)),
      emptyLabel: labels.noEntities
    }
  }
  const fits = (ids: readonly string[]): { scene: Scene | null; ok: boolean } => {
    const scene = layoutErd(diagramOf(ids))
    return { scene, ok: scene !== null && checkScene(scene, { allowBends: true }).length === 0 }
  }
  /** Tách đôi theo thứ tự duyệt tới khi hình qua `checkScene`; một entity lẻ thì dừng. */
  const refine = (ids: readonly string[]): string[][] => {
    if (ids.length < 2 || fits(ids).ok) return [[...ids]]
    const ordered = traversalOrder(ids, relations.filter((r) => ids.includes(r.from) && ids.includes(r.to)))
    const half = Math.ceil(ordered.length / 2)
    return [ordered.slice(0, half), ordered.slice(half)].flatMap(refine)
  }

  if (entities.length === 0) return [{ title: labels.erdTitle, scene: layoutErd(diagramOf([])), diagram: diagramOf([]) }]
  const grouped = groupEntities(traversalOrder(entities.map((e) => e.id), relations), relations, MAX_ENTITIES_PER_DIAGRAM).flatMap(refine)
  return grouped.map((ids, i) => ({
    title: grouped.length > 1 ? `${labels.erdTitle} (${i + 1}/${grouped.length})` : labels.erdTitle,
    scene: layoutErd(diagramOf(ids)),
    diagram: diagramOf(ids)
  }))
}

const meta = (): Pick<RenderedPart, "kind" | "section" | "owner_kind" | "owner_id"> => ({ kind: "erd", section: ERD_SECTION, owner_kind: null, owner_id: null })

export const renderErd: Renderer = (spine, _ownerId, labels = DIAGRAM_LABELS.en, context = {}) =>
  partitionErd(spine, context.erdNotation ?? DEFAULT_ERD_NOTATION, labels).map(({ title, scene }) => {
    if (scene) return svgPart(scene, { allowBends: true }, meta(), title)
    // Không tìm được đường cho mọi cạnh dù nới khe và tách tới một entity: báo lỗi bố cục thay vì ra hình sai
    const empty = svgPart(new Scene(), { allowBends: true }, meta(), title)
    return { ...empty, issues: [{ rule: "line_overlap", ids: [], message: "ERD: không tìm được đường nối không chồng / xuyên hình" }] }
  })
