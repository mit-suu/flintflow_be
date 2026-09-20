/**
 * §1 System Context — source_fields: `project.name` · `actors[].name/.kind` · `use_cases[].name/.actor_ids`
 * (srs-spine §7.1). Kiểu sơ đồ luồng dữ liệu mức 0: hệ thống là vòng tròn ở giữa, mọi actor là hình chữ nhật.
 * Nhãn cạnh = tên các use case actor tham gia (Spine không lưu nhãn tương tác riêng); chưa có use case thì
 * cạnh không nhãn — S-3.6 render lại hình sau khi S-3 thêm use case.
 */

import type { Actor, Spine } from "../../spine/spine.types.js"
import type { Renderer } from "./common.js"
import { alias, byId, label, puml } from "./common.js"

const SYSTEM_ALIAS = "SYSTEM_"
/** Số tên use case tối đa trên một cạnh, phần còn lại gộp thành "+ N more". */
const MAX_EDGE_USE_CASES = 3

const edgeLabel = (spine: Spine, actor: Actor): string => {
  const names = byId(spine.use_cases.filter((uc) => uc.actor_ids.includes(actor.id))).map((uc) => label(uc.name))
  const shown = names.slice(0, MAX_EDGE_USE_CASES)
  if (names.length > shown.length) shown.push(`+ ${names.length - shown.length} more`)
  return shown.length > 0 ? ` : ${shown.join("\\n")}` : ""
}

export const renderContext: Renderer = (spine) => {
  const actors = byId(spine.actors)
  // Hệ thống ngoài nhận lời gọi từ hệ thống (bên phải); người dùng và bộ hẹn giờ gửi vào (bên trái)
  const edge = (a: Actor): string =>
    a.kind === "system" ? `${SYSTEM_ALIAS} --> ${alias(a.id)}${edgeLabel(spine, a)}` : `${alias(a.id)} --> ${SYSTEM_ALIAS}${edgeLabel(spine, a)}`
  const body = [
    "skinparam monochrome true",
    "skinparam shadowing false",
    // polyline: cạnh thẳng thay cho spline cong; ortho làm chồng nhãn
    "skinparam linetype polyline",
    "skinparam nodesep 30",
    "skinparam ranksep 120",
    "skinparam usecaseFontSize 16",
    "left to right direction",
    // usecase vẽ hình ellipse; dòng trống trên/dưới để thành vòng tròn lớn
    `usecase "\\n\\n   ${label(spine.project.name) || "System"}   \\n\\n" as ${SYSTEM_ALIAS}`,
    ...actors.map((a) => `rectangle "${label(a.name)}" as ${alias(a.id)}`),
    ...actors.map(edge)
  ]
  return [{ kind: "context", section: "fixed:1", owner_kind: null, owner_id: null, puml: puml("@startuml", body, "@enduml") }]
}
