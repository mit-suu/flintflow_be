/**
 * §1 System Context — source_fields: `project.name` · `actors[].name/.kind/.flows_in/.flows_out` ·
 * `use_cases[].name/.actor_ids` (srs-spine §7.1). Sơ đồ luồng dữ liệu mức 0: hệ thống là vòng tròn ở
 * giữa, actor là hình chữ nhật xếp thành vòng quanh nó.
 *
 * MỘT cạnh cho mỗi actor. Actor trao đổi hai chiều thì cạnh mang mũi tên ở cả hai đầu và nhãn hai dòng,
 * mỗi dòng mở đầu bằng ký hiệu chỉ chiều (`↓ flows_in`, `↑ flows_out`). Vẽ hai cạnh riêng thì Graphviz
 * luôn đặt nhãn bên phải cạnh, nên nhãn của cạnh bên trái rơi vào giữa cặp và hình bị lệch.
 *
 * Actor chưa có nhãn luồng nào thì cạnh một chiều mang tên các use case actor tham gia, chiều suy từ
 * `kind`; không có cả use case thì cạnh trơn.
 */

import type { Actor, Spine } from "../../spine/spine.types.js"
import type { Renderer } from "./common.js"
import { alias, byId, label, puml } from "./common.js"

const SYSTEM_ALIAS = "SYSTEM_"
/** Số nhãn tối đa mỗi chiều, phần còn lại gộp thành "+ N more". */
const MAX_EDGE_LABELS = 3

type Side = "left" | "right" | "top" | "bottom"
/** Actor xếp vòng quanh hệ thống theo thứ tự id: trái, phải, rồi xen kẽ hàng trên và hàng dưới. */
const sideOf = (index: number): Side => (index === 0 ? "left" : index === 1 ? "right" : index % 2 === 0 ? "top" : "bottom")
/**
 * Trong PlantUML, hướng của `-x->` đặt ĐÍCH so với NGUỒN, nên cùng một vị trí cần hai từ khoá khác nhau
 * tuỳ cạnh đi vào hay đi ra khỏi hệ thống.
 */
const INTO_SYSTEM: Record<Side, string> = { left: "right", top: "down", right: "left", bottom: "up" }
const FROM_SYSTEM: Record<Side, string> = { left: "left", top: "up", right: "right", bottom: "down" }
/** Ký hiệu chỉ chiều trên nhãn: [actor → hệ thống, hệ thống → actor] theo vị trí của actor. */
const ARROWS: Record<Side, [into: string, from: string]> = {
  left: ["→", "←"],
  right: ["←", "→"],
  top: ["↓", "↑"],
  bottom: ["↑", "↓"]
}

const clean = (values: readonly string[] | undefined): string[] => (values ?? []).map(label).filter((v) => v.length > 0)

const capped = (names: string[]): string[] => {
  const shown = names.slice(0, MAX_EDGE_LABELS)
  if (names.length > shown.length) shown.push(`+ ${names.length - shown.length} more`)
  return shown
}

const edgeFor = (spine: Spine, actor: Actor, side: Side): string => {
  const a = alias(actor.id)
  const [intoArrow, fromArrow] = ARROWS[side]
  const flowsIn = clean(actor.flows_in)
  const flowsOut = clean(actor.flows_out)
  if (flowsIn.length > 0 && flowsOut.length > 0) {
    // Một đường, mũi tên hai đầu: đối xứng vì chỉ có một cạnh
    const text = [`${intoArrow} ${capped(flowsIn).join(", ")}`, `${fromArrow} ${capped(flowsOut).join(", ")}`].join("\\n")
    return `${a} <-${INTO_SYSTEM[side]}-> ${SYSTEM_ALIAS} : ${text}`
  }
  const into = `${a} -${INTO_SYSTEM[side]}-> ${SYSTEM_ALIAS}`
  const from = `${SYSTEM_ALIAS} -${FROM_SYSTEM[side]}-> ${a}`
  if (flowsIn.length > 0) return `${into} : ${capped(flowsIn).join("\\n")}`
  if (flowsOut.length > 0) return `${from} : ${capped(flowsOut).join("\\n")}`
  // Chưa có nhãn luồng: cạnh mang tên use case, chiều suy từ kind
  const useCases = capped(byId(spine.use_cases.filter((uc) => uc.actor_ids.includes(actor.id))).map((uc) => label(uc.name)))
  const edge = actor.kind === "system" ? from : into
  return useCases.length > 0 ? `${edge} : ${useCases.join("\\n")}` : edge
}

export const renderContext: Renderer = (spine) => {
  const actors = byId(spine.actors)
  const body = [
    "skinparam monochrome true",
    "skinparam shadowing false",
    // Không đặt "linetype": spline mặc định giữ cạnh thẳng; "polyline" làm gãy khúc, "ortho" chồng nhãn
    "skinparam nodesep 45",
    "skinparam ranksep 110",
    "skinparam usecaseFontSize 16",
    // usecase vẽ hình ellipse; dòng trống trên/dưới để thành vòng tròn lớn
    `usecase "\\n\\n   ${label(spine.project.name) || "System"}   \\n\\n" as ${SYSTEM_ALIAS}`,
    ...actors.map((a) => `rectangle "${label(a.name)}" as ${alias(a.id)}`),
    ...actors.map((a, i) => edgeFor(spine, a, sideOf(i)))
  ]
  return [{ kind: "context", section: "fixed:1", owner_kind: null, owner_id: null, puml: puml("@startuml", body, "@enduml") }]
}
