/**
 * Class diagram mức phân tích (domain) — source_fields: `entities[].name/.attributes/.feature_ids/.relations/
 * .relation_verbs/.relation_cardinality/.relation_optional` · `features[].name/.order` (srs-spine §7.1). UML 2.5.1, dựng
 * bằng SVG (hình học ở `class-layout.ts`, bộ xếp / đi đường dùng chung với ERD).
 *
 * MỖI FEATURE MỘT HÌNH (`entities[].feature_ids`): entity thuộc nhiều feature xuất hiện ở nhiều hình; chỉ quan hệ giữa các
 * entity cùng hình được vẽ (quan hệ sang feature khác nằm ở ERD toàn hệ thống). Entity không thuộc feature nào còn tồn
 * tại không có hình. Hình của feature nằm ở đầu mục `feature:<id>` (owner_kind `feature`). Hình quá `MAX_CLASSES_PER_DIAGRAM` class tách theo thành phần liên thông / cắt cụm như ERD, tiêu đề `(i/n)`;
 * hình không qua `checkScene` tách đôi tiếp. Phần đầu của mỗi feature giữ id gốc của hình (`diagram.service.ts#assignIds`).
 *
 * Nguồn là Spine: không tự thêm class. Quan hệ Spine chỉ là association cha → con: bản số cha `1` (hoặc `0..1` khi
 * `relation_optional`), bản số con `*` (`relation_cardinality` N) hoặc `0..1` (cardinality 1); số tối thiểu phía con
 * không có trong Spine nên là 0. Tên quan hệ = `relation_verbs` (thiếu ⇒ `has`). Chưa có dữ liệu aggregation / composition /
 * generalization trong Spine nên renderer không sinh ba loại này.
 */

import { checkScene } from "../../../shared/diagram/svg-geometry.js"
import { Scene } from "../../../shared/diagram/svg-scene.js"
import { entityGroups } from "../../spine/entity-features.js"
import type { Entity } from "../../spine/spine.types.js"
import type { RenderedPart, Renderer } from "./common.js"
import { compareIds, svgPart } from "./common.js"
import { layoutClass, type ClassDiagram, type ClassNodeInput, type ClassRelationInput } from "./class-layout.js"
import { groupEntities, relationVerb, traversalOrder } from "./erd.renderer.js"
import { DIAGRAM_LABELS, type DiagramLabels } from "./labels.js"

export const MAX_CLASSES_PER_DIAGRAM = 25
export interface ClassPart {
  featureId: string
  title: string
  diagram: ClassDiagram
}

const clean = (text: string): string => text.replace(/\s+/g, " ").trim()

const nodeOf = (e: Entity): ClassNodeInput => ({
  id: e.id,
  name: e.name,
  attributes: (e.attributes ?? []).map((a) => ({ name: a.name, kind: a.kind, required: a.required }))
})

const relationsOf = (entities: readonly Entity[], labels: DiagramLabels): ClassRelationInput[] => {
  const ids = new Set(entities.map((e) => e.id))
  return entities.flatMap((e) =>
    [...new Set(e.relations)]
      .sort(compareIds)
      .filter((target) => ids.has(target))
      .map((target): ClassRelationInput => ({
        id: `${e.id}>${target}`,
        from: e.id,
        to: target,
        kind: "association",
        name: relationVerb(e, target, labels.relationVerb),
        fromMultiplicity: e.relation_optional?.includes(target) ? "0..1" : "1",
        toMultiplicity: (e.relation_cardinality?.[target] ?? "N") === "N" ? "*" : "0..1"
      }))
  )
}

/** Mọi hình class diagram của Spine theo thứ tự trong tài liệu (feature theo `order`, nhóm chưa gán cuối). */
export const partitionClass = (spine: Parameters<typeof entityGroups>[0], labels: DiagramLabels = DIAGRAM_LABELS.en): ClassPart[] => {
  const featureName = new Map(spine.features.map((f) => [f.id, clean(f.name) || f.id]))
  const out: ClassPart[] = []
  for (const group of entityGroups(spine)) {
    const groupName = featureName.get(group.featureId) ?? group.featureId
    const byEntity = new Map(group.entities.map((e) => [e.id, e]))
    const relations = relationsOf(group.entities, labels)
    const diagramOf = (ids: readonly string[]): ClassDiagram => {
      const set = new Set(ids)
      return {
        nodes: group.entities.filter((e) => set.has(e.id)).map(nodeOf),
        relations: relations.filter((r) => set.has(r.from) && set.has(r.to))
      }
    }
    const fits = (ids: readonly string[]): boolean => {
      const scene = layoutClass(diagramOf(ids))
      return scene !== null && checkScene(scene, { allowBends: true }).length === 0
    }
    /** Tách đôi theo thứ tự duyệt tới khi hình qua `checkScene`; một class lẻ thì dừng. */
    const refine = (ids: readonly string[]): string[][] => {
      if (ids.length < 2 || fits(ids)) return [[...ids]]
      const ordered = traversalOrder(ids, relations.filter((r) => ids.includes(r.from) && ids.includes(r.to)))
      const half = Math.ceil(ordered.length / 2)
      return [ordered.slice(0, half), ordered.slice(half)].flatMap(refine)
    }
    const ids = [...byEntity.keys()]
    const parts = groupEntities(traversalOrder(ids, relations), relations, MAX_CLASSES_PER_DIAGRAM).flatMap(refine)
    parts.forEach((partIds, i) =>
      out.push({
        featureId: group.featureId,
        title: labels.classTitle(parts.length > 1 ? `${groupName} (${i + 1}/${parts.length})` : groupName),
        diagram: diagramOf(partIds)
      })
    )
  }
  return out
}

const meta = (featureId: string): Pick<RenderedPart, "kind" | "section" | "owner_kind" | "owner_id"> => ({
  kind: "class",
  section: `feature:${featureId}`,
  owner_kind: "feature",
  owner_id: featureId
})

export const renderClass: Renderer = (spine, _ownerId, labels = DIAGRAM_LABELS.en) =>
  partitionClass(spine, labels).map(({ featureId, title, diagram }) => {
    const scene = layoutClass(diagram)
    if (scene) return svgPart(scene, { allowBends: true }, meta(featureId), title)
    // Không tìm được đường cho mọi cạnh dù nới khe và tách tới một class: báo lỗi bố cục thay vì ra hình sai
    const empty = svgPart(new Scene(), { allowBends: true }, meta(featureId), title)
    return { ...empty, issues: [{ rule: "line_overlap", ids: [], message: "Class diagram: không tìm được đường nối không chồng / xuyên hình" }] }
  })
