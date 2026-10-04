/**
 * §3.1.5 ERD — source_fields: `entities[].name/.relations/.relation_verbs` (srs-spine §7.1).
 * Ký pháp Chen (`@startchen`): entity là hình chữ nhật, mỗi quan hệ là một hình thoi chứa động từ
 * (`relation_verbs`, thiếu ⇒ `has`). Thuộc tính không vẽ (không thuộc source_fields). Phía cha `1`, hoặc `(0,1)`
 * khi con nằm trong `relation_optional` (con tồn tại được không có cha này — `-0..1-` là lỗi cú pháp trong
 * `@startchen`, ký pháp min–max `(0,1)` thì hợp lệ); phía con theo `relation_cardinality`, thiếu ⇒ `N`.
 */

import type { Entity } from "../../spine/spine.types.js"
import type { Renderer } from "./common.js"
import { alias, byId, compareIds, label, puml } from "./common.js"

/** Động từ khi quan hệ chưa có `relation_verbs` — hình thoi không bao giờ trống. */
export const DEFAULT_RELATION_VERB = "has"

export const relationVerb = (entity: Pick<Entity, "relation_verbs">, targetId: string): string =>
  entity.relation_verbs?.[targetId]?.trim() || DEFAULT_RELATION_VERB

export const renderErd: Renderer = (spine) => {
  const entities = byId(spine.entities)
  const ids = new Set(entities.map((e) => e.id))
  // Hình thoi chiếm một tầng riêng ⇒ chuỗi cha–con sâu làm hình rất dài; khoảng cách tầng mặc định của Graphviz
  // quá rộng cho trang A4 dọc. Đường gấp khúc (polyline) thay cho đường cong; KHÔNG dùng ortho (FLF-243): ortho gộp
  // các đoạn song song làm một nên nhiều quan hệ cùng đổ vào một entity chồng lên nhau, không còn biết hình thoi nào nối đâu.
  const body = ["skinparam monochrome true", "skinparam ranksep 20", "skinparam linetype polyline"]

  if (entities.length === 0) body.push('entity "No entities yet" as NO_ENTITIES {', "}")
  for (const e of entities) body.push(`entity "${label(e.name)}" as ${alias(e.id)} {`, "}")
  for (const e of entities) {
    for (const target of [...new Set(e.relations)].sort(compareIds)) {
      if (!ids.has(target)) continue
      const rel = `R_${alias(e.id)}_${alias(target)}`
      const child = e.relation_cardinality?.[target] ?? "N"
      const parent = e.relation_optional?.includes(target) ? "(0,1)" : "1"
      body.push(`relationship "${label(relationVerb(e, target))}" as ${rel} {`, "}", `${alias(e.id)} -${parent}- ${rel}`, `${rel} -${child}- ${alias(target)}`)
    }
  }

  return [{ kind: "erd", section: "fixed:3.1.5", owner_kind: null, owner_id: null, puml: puml("@startchen", body, "@endchen") }]
}
