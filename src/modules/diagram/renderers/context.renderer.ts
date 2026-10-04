/**
 * §1 System Context — source_fields: `project.system_name ?? project.name` · `actors[].name/.kind/.flows_in/.flows_out`
 * (srs-spine §7.1). Sơ đồ luồng dữ liệu mức 0, nét đen: hệ thống là vòng tròn nền xám ở giữa, actor là hình chữ nhật nền trắng
 * quây quanh theo vai trò (hình học ở `context-layout.ts`).
 *
 * Mỗi phần tử của `flows_in` (actor → hệ thống) / `flows_out` (hệ thống → actor) là một mũi tên mang đúng một nhãn.
 * Một actor được có luồng một chiều (không ghép cặp), nhưng:
 * - mọi mũi tên đều mang dữ liệu: quá MAX_ARROWS phần tử một chiều thì mũi tên cuối gộp phần còn lại
 *   (`a, b, c`), không có `+ N more`;
 * - toàn sơ đồ phải có cả chiều vào lẫn chiều ra.
 * Skill S-2.3/S-3.x bắt buộc ghi luồng thật; nhãn dự phòng theo `kind` (DEFAULT_IN/DEFAULT_OUT) chỉ để sơ đồ không
 * bao giờ có mũi tên trơn khi Spine còn thiếu (dữ liệu cũ, model bỏ sót). Không lấy tên use case làm nhãn vì đó là
 * hành động, không phải dữ liệu.
 */

import type { Actor, ActorKind } from "../../spine/spine.types.js"
import { systemName } from "../../spine/system-name.js"
import type { Renderer } from "./common.js"
import { alias, byId, label, puml } from "./common.js"
import { buildContextLayout, contextLabelLines, type ContextActor, type ContextEdge, type Point } from "./context-layout.js"

const SYSTEM_ALIAS = "SYSTEM_"
/** Số mũi tên tối đa mỗi chiều của một actor; dữ liệu dư gộp vào mũi tên cuối. */
export const MAX_ARROWS = 3
/** Nhãn dự phòng khi Spine thiếu luồng: chiều vào / chiều ra theo `kind`. */
export const DEFAULT_IN: Readonly<Record<ActorKind, string>> = { human: "user input", system: "service response", time: "scheduled trigger" }
export const DEFAULT_OUT: Readonly<Record<ActorKind, string>> = { human: "processing result", system: "service request", time: "job status" }
/** Khoảng cắt bớt cuối đường để chừa chỗ cho đầu mũi tên. */
const ARROWHEAD = 8

const clean = (values: readonly string[] | undefined): string[] => (values ?? []).map(label).filter((v) => v.length > 0)
const merged = (values: string[]): string[] =>
  values.length > MAX_ARROWS ? [...values.slice(0, MAX_ARROWS - 1), values.slice(MAX_ARROWS - 1).join(", ")] : values

/** Actor của sơ đồ, theo id: mỗi actor ít nhất một mũi tên có nhãn, toàn sơ đồ có cả chiều vào lẫn chiều ra. */
export const contextActors = (actors: readonly Actor[]): ContextActor[] => {
  const result = byId([...actors]).map((a) => {
    const flows = { id: a.id, name: label(a.name), kind: a.kind, inbound: merged(clean(a.flows_in)), outbound: merged(clean(a.flows_out)) }
    // Chưa có luồng nào: chiều chính theo kind — human/time gửi vào hệ thống, system nhận yêu cầu từ hệ thống
    if (flows.inbound.length > 0 || flows.outbound.length > 0) return flows
    return a.kind === "system" ? { ...flows, outbound: [DEFAULT_OUT.system] } : { ...flows, inbound: [DEFAULT_IN[a.kind]] }
  })
  // Cả sơ đồ chỉ một chiều: thêm chiều thiếu cho actor đầu tiên theo thứ tự kind ưu tiên
  const first = (order: ActorKind[]): number => {
    for (const kind of order) {
      const i = result.findIndex((a) => a.kind === kind)
      if (i >= 0) return i
    }
    return 0
  }
  if (result.length > 0 && !result.some((a) => a.outbound.length > 0)) {
    const i = first(["human", "system", "time"])
    result[i] = { ...result[i], outbound: [DEFAULT_OUT[result[i].kind]] }
  }
  if (result.length > 0 && !result.some((a) => a.inbound.length > 0)) {
    const i = first(["system", "human", "time"])
    result[i] = { ...result[i], inbound: [DEFAULT_IN[result[i].kind]] }
  }
  return result
}

/** Tên hệ thống gói ở 26 ký tự (khớp cách tính bán kính), tên actor ở 18 (khớp bề rộng hộp). */
const dotLabel = (text: string, limit: number): string => JSON.stringify(contextLabelLines(text, limit).join("\n"))
const flowLabel = (text: string): string => {
  const lines = contextLabelLines(text).map((line) => line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"))
  // Nền trắng không viền che nét của chính mũi tên dưới chữ
  return `<<TABLE BORDER="0" CELLBORDER="0" CELLSPACING="0" CELLPADDING="3" BGCOLOR="white"><TR><TD>${lines.join("<BR/>")}</TD></TR></TABLE>>`
}
const inches = (points: number): string => (points / 72).toFixed(6)
const coordinates = ({ x, y }: Point): string => `${x.toFixed(6)},${y.toFixed(6)}`
const position = (p: Point): string => `"${coordinates(p)}!"`
const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })

/** `pos` của Graphviz cho đường có đầu mũi tên: cắt đoạn cuối sao cho nét dừng cách đầu mũi tên ARROWHEAD. */
const edgePosition = (edge: ContextEdge): string => {
  const end = edge.path[edge.path.length - 1]
  const head = edge.path.slice(0, -4)
  const [p0, c1, c2, p3] = edge.path.slice(-4)
  // Tách đoạn cuối tại t (de Casteljau), giữ nguyên hình dạng phần đầu
  const prefix = (t: number): Point[] => {
    const a = lerp(p0, c1, t), b = lerp(c1, c2, t), c = lerp(c2, p3, t)
    const d = lerp(a, b, t), e = lerp(b, c, t)
    return [p0, a, d, lerp(d, e, t)]
  }
  let lower = 0, upper = 1
  for (let i = 0; i < 40; i++) {
    const t = (lower + upper) / 2
    const tip = prefix(t)[3]
    if (Math.hypot(end.x - tip.x, end.y - tip.y) > ARROWHEAD) lower = t
    else upper = t
  }
  return JSON.stringify(`e,${coordinates(end)} ${[...head, ...prefix((lower + upper) / 2)].map(coordinates).join(" ")}`)
}

export const renderContext: Renderer = (spine) => {
  const name = label(systemName(spine.project)) || "System"
  const layout = buildContextLayout(contextActors(spine.actors), name)
  const ports: string[] = []
  const edges: string[] = []
  for (const edge of layout.edges) {
    const actorPort = `${alias(edge.actorId)}_${edge.flow.toUpperCase()}_${edge.index}`
    const systemPort = `${SYSTEM_ALIAS}${actorPort}`
    const [from, to] = edge.flow === "in" ? [actorPort, systemPort] : [systemPort, actorPort]
    // Cổng ẩn kích thước 0 ghim hai đầu mũi tên đúng trên viền hộp / vòng tròn
    ports.push(`  ${from} [shape=point, style=invis, width=0, height=0, label="", pos=${position(edge.path[0])}];`)
    ports.push(`  ${to} [shape=point, style=invis, width=0, height=0, label="", pos=${position(edge.path[edge.path.length - 1])}];`)
    const text = edge.labelPoint ? `label=${flowLabel(edge.text)}, ` : ""
    const lp = edge.labelPoint ? `, lp="${coordinates(edge.labelPoint)}"` : ""
    edges.push(`  ${from} -> ${to} [${text}actor_id=${JSON.stringify(edge.actorId)}, flow="${edge.flow}", flow_index=${edge.index}, pos=${edgePosition(edge)}${lp}];`)
  }
  const body = [
    "digraph Context {",
    '  graph [layout=nop2, overlap=true, splines=true, bgcolor="white", pad=0.15, outputorder=edgesfirst];',
    '  node [fontname="sans-serif", fontsize=14, fontcolor="black", fixedsize=true, pin=true, style=filled, color="black", fillcolor="white", penwidth=1.2];',
    '  edge [fontname="sans-serif", fontsize=12, color="black", fontcolor="black", penwidth=1.2, arrowsize=0.7, headclip=false, tailclip=false];',
    `  ${SYSTEM_ALIAS} [shape=circle, pos="0,0!", width=${inches(layout.radiusX * 2)}, height=${inches(layout.radiusY * 2)}, label=${dotLabel(name, 26)}, fontsize=18, fillcolor="lightgray"];`,
    ...layout.actors.map((a) => `  ${alias(a.id)} [shape=box, pos=${position(a.center)}, width=${inches(a.width)}, height=${inches(a.height)}, label=${dotLabel(a.name, 18)}, sector="${a.sector}"];`),
    ...ports,
    ...edges,
    "}"
  ]
  return [{ kind: "context", section: "fixed:1", owner_kind: null, owner_id: null, puml: puml("@startdot", body, "@enddot") }]
}
