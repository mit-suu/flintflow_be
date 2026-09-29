/**
 * §1 System Context — source_fields: `project.system_name ?? project.name` · `actors[].name/.kind/.flows_in/.flows_out` ·
 * `use_cases[].name/.actor_ids` (srs-spine §7.1). Sơ đồ luồng dữ liệu mức 0: hệ thống là vòng tròn ở
 * giữa, actor là hình chữ nhật xếp thành vòng quanh nó.
 *
 * Actor trao đổi hai chiều có HAI đường riêng, nhãn nằm hai phía đối nhau: nhãn đường vào ở phía ngoài
 * bên trái, nhãn đường ra ở phía ngoài bên phải. Graphviz luôn đặt nhãn bên phải cạnh, nên nhãn đường vào
 * không gắn lên chính đường vào mà gắn lên một cạnh TRONG SUỐT chạy song song phía bên trái nó.
 *
 * Actor chưa có nhãn luồng nào thì cạnh một chiều mang tên các use case actor tham gia, chiều suy từ
 * `kind`; không có cả use case thì cạnh trơn.
 */

import type { Actor, Spine } from "../../spine/spine.types.js"
import { systemName } from "../../spine/system-name.js"
import type { Renderer } from "./common.js"
import { alias, byId, label, puml } from "./common.js"

const SYSTEM_ALIAS = "SYSTEM_"
/** Số nhãn tối đa mỗi chiều, phần còn lại gộp thành "+ N more". */
const MAX_EDGE_LABELS = 3
/**
 * Đệm quanh tên hệ thống để ellipse đủ lớn. Nhỏ quá thì các cạnh hàng trên dồn vào sát góc vòng tròn
 * và cắt ngang nhãn của actor trái/phải (thấy rõ với font DejaVu của PlantUML server).
 */
const SYSTEM_PAD_LINES = 4
const SYSTEM_PAD_SPACES = 8

type Side = "left" | "right" | "top" | "bottom"
/**
 * Trong PlantUML, hướng của `-x->` đặt ĐÍCH so với NGUỒN, nên cùng một vị trí cần hai từ khoá khác nhau
 * tuỳ cạnh đi vào hay đi ra khỏi hệ thống.
 */
const INTO_SYSTEM: Record<Side, string> = { left: "right", top: "down", right: "left", bottom: "up" }
const FROM_SYSTEM: Record<Side, string> = { left: "left", top: "up", right: "right", bottom: "down" }

const clean = (values: readonly string[] | undefined): string[] => (values ?? []).map(label).filter((v) => v.length > 0)

/** Actor vẽ hai đường riêng (có nhãn cho cả hai chiều). */
const isTwoWay = (a: Actor): boolean => clean(a.flows_in).length > 0 && clean(a.flows_out).length > 0

/**
 * Số cặp hai chiều tối đa ở hàng trên. Cặp hàng trên luôn được Graphviz uốn đều cả hai đường; cặp hàng
 * dưới nằm thẳng dưới vòng tròn thì đường vào bị giữ thẳng. Nhiều hơn 4 cặp một hàng thì hình dẹt quá
 * và nhãn trôi xa đường, nên phần dư xuống hàng dưới.
 */
const MAX_TOP_PAIRS = 4

/**
 * Xếp actor quanh hệ thống (theo thứ tự id):
 * - Actor hai chiều: hàng trên trước, tối đa `MAX_TOP_PAIRS`, dư xuống hàng dưới. Không bao giờ nằm
 *   trái/phải: cặp đường nằm ngang không tách được nhãn ra hai phía.
 * - Actor một chiều: trái, phải, rồi vào hàng đang ít actor hơn (hoà thì hàng dưới) — để hàng trên dành
 *   cho các cặp, tránh nhãn của cạnh một chiều đứng sát nhãn đường vào của một cặp như cùng một dòng chữ.
 */
const sidesOf = (actors: readonly Actor[]): Map<string, Side> => {
  const sides = new Map<string, Side>()
  const count = { top: 0, bottom: 0 }
  for (const [i, a] of actors.filter(isTwoWay).entries()) {
    const side = i < MAX_TOP_PAIRS ? "top" : "bottom"
    sides.set(a.id, side)
    count[side]++
  }
  const ONE_WAY_SLOTS: readonly Side[] = ["left", "right"]
  for (const [i, a] of actors.filter((x) => !isTwoWay(x)).entries()) {
    const fixed = ONE_WAY_SLOTS[i]
    if (fixed) {
      sides.set(a.id, fixed)
      continue
    }
    const side = count.bottom <= count.top ? "bottom" : "top"
    sides.set(a.id, side)
    count[side]++
  }
  return sides
}

const edgeLabel = (names: string[]): string => {
  const shown = names.slice(0, MAX_EDGE_LABELS)
  if (names.length > shown.length) shown.push(`+ ${names.length - shown.length} more`)
  return shown.length > 0 ? ` : ${shown.join("\\n")}` : ""
}

const edgesFor = (spine: Spine, actor: Actor, side: Side): string[] => {
  const a = alias(actor.id)
  const into = `${a} -${INTO_SYSTEM[side]}-> ${SYSTEM_ALIAS}`
  const from = `${SYSTEM_ALIAS} -${FROM_SYSTEM[side]}-> ${a}`
  const flowsIn = clean(actor.flows_in)
  const flowsOut = clean(actor.flows_out)
  if (flowsIn.length > 0 && flowsOut.length > 0) {
    // Cạnh đệm trong suốt, không nhãn: Graphviz căn actor theo cạnh ở giữa bó cạnh của nó; thiếu đệm
    // thì actor căn thẳng hàng đường vào, đường vào thẳng còn đường ra cong
    const spacer = `${a} -[#transparent]${INTO_SYSTEM[side]}- ${SYSTEM_ALIAS}`
    return [
      // Cạnh trong suốt khai báo trước nằm bên trái cặp; nhãn của nó (bên phải nó) thành nhãn đường vào
      `${a} -[#transparent]${INTO_SYSTEM[side]}-> ${SYSTEM_ALIAS}${edgeLabel(flowsIn)}`,
      into,
      spacer,
      from + edgeLabel(flowsOut),
      spacer
    ]
  }
  if (flowsIn.length > 0) return [into + edgeLabel(flowsIn)]
  if (flowsOut.length > 0) return [from + edgeLabel(flowsOut)]
  // Chưa có nhãn luồng: cạnh mang tên use case, chiều suy từ kind
  const useCases = byId(spine.use_cases.filter((uc) => uc.actor_ids.includes(actor.id))).map((uc) => label(uc.name))
  return [(actor.kind === "system" ? from : into) + edgeLabel(useCases)]
}

const systemLabel = (name: string): string => {
  const lines = "\\n".repeat(SYSTEM_PAD_LINES)
  const spaces = " ".repeat(SYSTEM_PAD_SPACES)
  return `${lines}${spaces}${name}${spaces}${lines}`
}

export const renderContext: Renderer = (spine) => {
  const actors = byId(spine.actors)
  const sides = sidesOf(actors)
  const body = [
    "skinparam monochrome true",
    "skinparam shadowing false",
    // Không đặt "linetype": spline mặc định giữ cạnh thẳng; "polyline" làm gãy khúc, "ortho" chồng nhãn
    // nodesep nhỏ: nhãn đường vào nằm trên cạnh trong suốt, cách đường vào đúng một nodesep
    "skinparam nodesep 20",
    "skinparam ranksep 110",
    "skinparam usecaseFontSize 16",
    // usecase vẽ hình ellipse; dòng trống trên/dưới và dấu cách hai bên để thành vòng tròn lớn
    `usecase "${systemLabel(label(systemName(spine.project)) || "System")}" as ${SYSTEM_ALIAS}`,
    ...actors.map((a) => `rectangle "${label(a.name)}" as ${alias(a.id)}`),
    ...actors.flatMap((a) => edgesFor(spine, a, sides.get(a.id)!))
  ]
  return [{ kind: "context", section: "fixed:1", owner_kind: null, owner_id: null, puml: puml("@startuml", body, "@enduml") }]
}
