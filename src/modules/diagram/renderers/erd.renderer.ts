/**
 * §3.1.5 ERD — source_fields: `entities[].name/.relations` (srs-spine §7.1).
 * Thuộc tính không vẽ (không thuộc source_fields). `relations[]` chỉ có id đích, không có
 * bản số ⇒ mặc định `||--o{` (một – không hoặc nhiều); ghi ở docs/spec-gaps.md.
 */

import type { Renderer } from "./common.js"
import { alias, byId, compareIds, label, puml } from "./common.js"

export const DEFAULT_RELATION = "||--o{"

export const renderErd: Renderer = (spine) => {
  const entities = byId(spine.entities)
  const ids = new Set(entities.map((e) => e.id))
  const body = ["skinparam monochrome true", "hide circle", "hide empty members"]

  if (entities.length === 0) body.push('entity "No entities yet" as NO_ENTITIES')
  for (const e of entities) body.push(`entity "${label(e.name)}" as ${alias(e.id)}`)
  for (const e of entities) {
    for (const target of [...new Set(e.relations)].sort(compareIds)) {
      if (ids.has(target)) body.push(`${alias(e.id)} ${DEFAULT_RELATION} ${alias(target)}`)
    }
  }

  return [{ kind: "erd", section: "fixed:3.1.5", owner_kind: null, owner_id: null, puml: puml("@startuml", body, "@enduml") }]
}
