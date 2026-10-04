/**
 * §1 System Context — source_fields: `project.system_name ?? project.name` · `actors[].name/.kind/.flows_in/.flows_out` ·
 * `use_cases[].name/.actor_ids` (srs-spine §7.1). Sơ đồ luồng dữ liệu mức 0: hệ thống là vòng tròn ở
 * giữa, actor có một cặp in/out chia đều trên/dưới, actor có nhiều cặp nằm hai bên trái/phải.
 *
 * Mỗi requirement có một đường vào và một đường ra riêng, mỗi đường mang đúng một nhãn.
 * Ghép flows_in[i] với flows_out[i]; bổ sung nhãn dự phòng khi một phần tử trong cặp còn thiếu.
 *
 * Mỗi actor có đủ hai chiều. Ưu tiên nhãn luồng đã khai báo; dữ liệu cũ thiếu một chiều thì bổ sung
 * nhãn request/response tương ứng, thiếu cả hai thì dùng các use case actor tham gia.
 */

import type { Actor, Spine } from "../../spine/spine.types.js"
import { systemName } from "../../spine/system-name.js"
import type { Renderer } from "./common.js"
import { alias, byId, label, puml } from "./common.js"
import { buildContextLayout, contextLabelLines, type ContextEdge, type FlowPair, type Point } from "./context-layout.js"

const SYSTEM_ALIAS = "SYSTEM_"

const clean = (values: readonly string[] | undefined): string[] => (values ?? []).map(label).filter((v) => v.length > 0)

/** Ghép theo vị trí gốc, không lọc riêng từng chiều để tránh lệch cặp khi có nhãn rỗng. */
const flowsFor = (spine: Spine, actor: Actor): FlowPair[] => {
  const flowsIn = (actor.flows_in ?? []).map(label)
  const flowsOut = (actor.flows_out ?? []).map(label)
  const pairs: FlowPair[] = []
  for (let i = 0; i < Math.max(flowsIn.length, flowsOut.length); i++) {
    const input = flowsIn[i]
    const output = flowsOut[i]
    if (!input && !output) continue
    pairs.push({
      input: input || `Acknowledgement of ${output}`,
      output: output || `Response to ${input}`
    })
  }
  if (pairs.length > 0) return pairs

  const useCases = clean(byId(spine.use_cases.filter((uc) => uc.actor_ids.includes(actor.id))).map((uc) => uc.name))
  const names = useCases.length > 0 ? useCases : [actor.kind === "time" ? "Scheduled task" : `${label(actor.name)} interaction`]
  // Human/time khởi tạo yêu cầu; system nhận yêu cầu từ hệ thống và trả kết quả về.
  return names.map((name) => actor.kind === "system"
    ? { input: `${name} result`, output: `${name} request` }
    : { input: `${name} request`, output: `${name} result` })
}

const dotLabel = (text: string): string => JSON.stringify(contextLabelLines(text).join("\n"))
const flowLabel = (text: string): string => {
  const lines = contextLabelLines(text).map((line) => line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"))
  // A borderless white backing keeps curved strokes from running through the text.
  return `<<TABLE BORDER="0" CELLBORDER="0" CELLSPACING="0" CELLPADDING="3" BGCOLOR="white"><TR><TD>${lines.join("<BR/>")}</TD></TR></TABLE>>`
}
const inches = (points: number): string => (points / 72).toFixed(6)
const coordinates = ({ x, y }: Point): string => `${x.toFixed(6)},${y.toFixed(6)}`
// nop2 reads positions in points and preserves supplied cubic paths; dimensions remain in inches.
const position = (p: Point): string => `"${coordinates(p)}!"`
const curvePosition = (edge: ContextEdge): string => {
  const [first, second] = edge.controls
  const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
  // Split the curve before the arrowhead, retaining its shape and curvature.
  const prefix = (t: number): Point[] => {
    const a = lerp(edge.start, first, t), b = lerp(first, second, t), c = lerp(second, edge.end, t)
    const d = lerp(a, b, t), e = lerp(b, c, t)
    return [edge.start, a, d, lerp(d, e, t)]
  }
  let lower = 0, upper = 1
  for (let i = 0; i < 32; i++) {
    const t = (lower + upper) / 2
    const end = prefix(t)[3]
    if (Math.hypot(edge.end.x - end.x, edge.end.y - end.y) > 8) lower = t
    else upper = t
  }
  return JSON.stringify(`e,${coordinates(edge.end)} ${prefix((lower + upper) / 2).map(coordinates).join(" ")}`)
}

export const renderContext: Renderer = (spine) => {
  const name = label(systemName(spine.project)) || "System"
  const layout = buildContextLayout(byId(spine.actors).map((a) => ({ id: a.id, name: label(a.name), pairs: flowsFor(spine, a) })), name)
  const ports: string[] = []
  const edges: string[] = []
  for (const edge of layout.edges) {
    const actorPort = `${alias(edge.actorId)}_${edge.flow.toUpperCase()}_${edge.pairIndex}`
    const systemPort = `${SYSTEM_ALIAS}${actorPort}`
    const from = edge.flow === "in" ? actorPort : systemPort
    const to = edge.flow === "in" ? systemPort : actorPort
    // Invisible zero-sized ports position the VISIBLE arrows exactly on the node borders.
    ports.push(`  ${from} [shape=point, style=invis, width=0, height=0, label="", pos=${position(edge.start)}];`)
    ports.push(`  ${to} [shape=point, style=invis, width=0, height=0, label="", pos=${position(edge.end)}];`)
    edges.push(`  ${from} -> ${to} [label=${flowLabel(edge.text)}, actor_id=${JSON.stringify(edge.actorId)}, flow="${edge.flow}", pair_index=${edge.pairIndex}, pos=${curvePosition(edge)}, lp="${coordinates(edge.labelPoint)}"];`)
  }
  const body = [
    "digraph Context {",
    '  graph [layout=nop2, overlap=true, splines=true, bgcolor="white", pad=0.15, outputorder=edgesfirst];',
    '  node [fontname="sans-serif", fontsize=14, fixedsize=true, pin=true, style=filled, color="#64748B", fillcolor="white", penwidth=1.2];',
    '  edge [fontname="sans-serif", fontsize=12, color="#475569", fontcolor="#334155", penwidth=1.2, arrowsize=0.7, headclip=false, tailclip=false];',
    `  ${SYSTEM_ALIAS} [shape=circle, pos="0,0!", width=${inches(layout.radiusX * 2)}, height=${inches(layout.radiusY * 2)}, label=${dotLabel(name)}, fontsize=18, fillcolor="#F1F5F9", color="#475569"];`,
    ...layout.actors.map((a) => `  ${alias(a.id)} [shape=box, pos=${position(a.center)}, width=${inches(a.width)}, height=${inches(a.height)}, label=${dotLabel(a.name)}, side="${a.side}"];`),
    ...ports,
    ...edges,
    "}"
  ]
  return [{ kind: "context", section: "fixed:1", owner_kind: null, owner_id: null, puml: puml("@startdot", body, "@enddot") }]
}
