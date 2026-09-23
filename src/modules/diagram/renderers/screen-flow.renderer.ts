/**
 * §3.1.1 Screens Flow — source_fields: `screens[].name/.flow_to/.is_popup/.tabs` + liên kết màn ↔ actor người
 * (`screen-actors.ts`, srs-spine §7.1).
 * Tách MỘT sơ đồ cho mỗi actor người tương tác trực tiếp với UI: chỉ màn actor đó dùng và cạnh giữa chúng,
 * điểm bắt đầu là HÌNH THOI mang tên actor, trỏ vào màn vào (không popup, không có cạnh tới trong nhóm). Màn không
 * thuộc actor nào là màn mồ côi — vẫn vẽ ở sơ đồ "Unassigned screens" cuối cùng để không giấu nội dung, cờ
 * `orphan_screen` bắt nó.
 * Chưa có liên kết màn ↔ actor nào (trước S-4.3/S-4.4) ⇒ một sơ đồ chung như cũ.
 * Vẽ bằng Graphviz DOT (`@startdot`) thay vì state diagram: state diagram không đặt được chữ vào trong hình thoi
 * (`<<choice>>` là hình thoi nhỏ cố định, không nhãn). Màn = hộp bo góc; màn có `tabs[]` ⇒ cluster, mỗi tab một
 * node `<screen>_T<n>`, cạnh tới/đi màn đó gắn vào cluster (`lhead`/`ltail`); `is_popup` ⇒ viền đứt + dòng `(pop-up)`.
 * Sơ đồ chung (chưa tách actor) và sơ đồ màn mồ côi bắt đầu bằng chấm đen như cũ — không có actor để ghi tên.
 * Font `DejaVu Sans`: font mặc định của Graphviz trong image PlantUML thiếu (fontconfig báo lỗi thay vì vẽ).
 * Hộp màn KHÔNG tô nền: PlantUML vẽ lại SVG của dot và bỏ viền của node vừa `rounded` vừa `filled`.
 * Cạnh chỉ vẽ MỘT chiều: cặp màn trỏ qua lại (A → B và B → A) chỉ giữ chiều đi tiếp từ màn vào — màn gần màn vào
 * hơn (BFS) trỏ sang màn xa hơn; bằng nhau thì theo `queue_order`, rồi id. Đường quay lại là ngầm định.
 * Tiêu đề hình `Screens flow for <actor>` (thuộc tính `label` của graph) — `section-renderer` lấy làm chú thích ảnh
 * qua `screenFlowTitleOf`.
 */

import type { Screen, Spine } from "../../spine/spine.types.js"
import { hasScreenActorLinks, screenActorMap } from "../../spine/screen-actors.js"
import type { RenderedPart, Renderer } from "./common.js"
import { alias, byId, compareIds, label, puml } from "./common.js"

const FONT = "DejaVu Sans"
/** Chuỗi DOT trong ngoặc kép: nhãn một dòng (`label` bỏ `"`), escape `\`. `lines` nối bằng `\n` của DOT. */
const dq = (...lines: string[]): string => `"${lines.map((l) => label(l).replace(/\\/g, "\\\\")).join("\\n")}"`

const byQueueOrder = (a: Screen, b: Screen): number =>
  (a.queue_order ?? Number.MAX_SAFE_INTEGER) - (b.queue_order ?? Number.MAX_SAFE_INTEGER) || compareIds(a.id, b.id)

/** Màn vào của nhóm: không popup và không có cạnh tới từ màn cùng nhóm; không có ⇒ màn queue_order thấp nhất. */
const entryScreens = (screens: Screen[], ids: Set<string>): Screen[] => {
  const targeted = new Set(screens.flatMap((s) => s.flow_to.filter((t) => ids.has(t) && t !== s.id)))
  const entries = screens.filter((s) => !s.is_popup && !targeted.has(s.id))
  return entries.length > 0 ? entries.sort(byQueueOrder) : [[...screens].sort(byQueueOrder)[0]]
}

/** Tiêu đề sơ đồ của một actor; cũng là chú thích ảnh (`section-renderer` đọc lại bằng `screenFlowTitleOf`). */
export const screenFlowTitle = (actorName: string): string => `Screens flow for ${actorName}`
export const UNASSIGNED_SCREENS_TITLE = "Screens flow for unassigned screens"

/** Tiêu đề đã ghi trong nguồn sơ đồ (dòng `label="…";` cấp graph); sơ đồ chung không có ⇒ `null`. */
export const screenFlowTitleOf = (source: string): string | null => /^ {2}label="([^"]*)";$/m.exec(source)?.[1] ?? null

/** Khoảng cách BFS từ các màn vào theo cạnh trong nhóm; không tới được ⇒ vô cùng. */
const depthFrom = (entries: Screen[], edges: Map<string, string[]>): Map<string, number> => {
  const depth = new Map(entries.map((s) => [s.id, 0]))
  const queue = entries.map((s) => s.id)
  for (let i = 0; i < queue.length; i++) {
    for (const next of edges.get(queue[i]) ?? []) {
      if (depth.has(next)) continue
      depth.set(next, depth.get(queue[i])! + 1)
      queue.push(next)
    }
  }
  return depth
}

/** Cạnh một chiều trong nhóm: bỏ vòng tự trỏ, trùng lặp, và chiều ngược của cặp trỏ qua lại. */
const oneWayEdges = (screens: Screen[], entries: Screen[]): [string, string][] => {
  const byIdMap = new Map(screens.map((s) => [s.id, s]))
  const edges = new Map(
    screens.map((s) => [s.id, [...new Set(s.flow_to)].filter((t) => byIdMap.has(t) && t !== s.id).sort(compareIds)])
  )
  const depth = depthFrom(entries, edges)
  const rank = (id: string) => depth.get(id) ?? Number.MAX_SAFE_INTEGER
  // a đi trước b: gần màn vào hơn, rồi queue_order, rồi id
  const before = (a: string, b: string): boolean => (rank(a) - rank(b) || byQueueOrder(byIdMap.get(a)!, byIdMap.get(b)!)) < 0
  return screens.flatMap((s) =>
    (edges.get(s.id) ?? [])
      .filter((t) => !(edges.get(t) ?? []).includes(s.id) || before(s.id, t))
      .map((t): [string, string] => [s.id, t])
  )
}

interface FlowStart {
  title: string
  /** Tên trong hình thoi bắt đầu; `null` ⇒ chấm đen (không có actor). */
  actorName: string | null
}

const flowPart = (screens: Screen[], start: FlowStart | null): RenderedPart => {
  const ids = new Set(screens.map((s) => s.id))
  const tabbed = new Map(screens.filter((s) => s.tabs.length > 0).map((s) => [s.id, `${alias(s.id)}_T1`]))
  const body = [
    "digraph screens_flow {",
    `  graph [fontname=${dq(FONT)}, fontsize=13, labelloc=t, compound=true, nodesep=0.4, ranksep=0.5];`,
    `  node [fontname=${dq(FONT)}, fontsize=11, shape=box, style=rounded, color="#000000"];`,
    "  edge [arrowsize=0.8];"
  ]
  if (start) body.push(`  label=${dq(start.title)};`)

  if (screens.length === 0) {
    body.push(`  NO_SCREENS [label=${dq("No screens yet")}];`, "}")
    return { kind: "screen_flow", section: "fixed:3.1.1", owner_kind: null, owner_id: null, puml: puml("@startdot", body, "@enddot") }
  }

  // Sơ đồ chung (chưa tách actor) giữ một điểm vào như trước
  const entries = start === null ? [[...screens].sort(byQueueOrder)[0]] : entryScreens(screens, ids)
  body.push(
    start?.actorName
      ? `  START [label=${dq(start.actorName)}, shape=diamond, style=solid];`
      : '  START [label="", shape=circle, style=filled, fillcolor="#000000", width=0.2, fixedsize=true];'
  )

  for (const s of screens) {
    if (s.tabs.length === 0) {
      body.push(
        s.is_popup
          ? `  ${alias(s.id)} [label=${dq(s.name, "(pop-up)")}, style="rounded,dashed"];`
          : `  ${alias(s.id)} [label=${dq(s.name)}];`
      )
      continue
    }
    body.push(
      `  subgraph cluster_${alias(s.id)} {`,
      `    label=${s.is_popup ? dq(s.name, "(pop-up)") : dq(s.name)}; style=${s.is_popup ? '"rounded,dashed"' : "rounded"};`
    )
    s.tabs.forEach((tab, i) => body.push(`    ${alias(s.id)}_T${i + 1} [label=${dq(tab)}];`))
    body.push("  }")
  }

  // Cạnh tới/đi màn nhiều tab gắn vào tab đầu, cắt ở biên cluster
  const endpoint = (id: string) => tabbed.get(id) ?? alias(id)
  const clip = (from: string, to: string) =>
    [tabbed.has(from) ? `ltail=cluster_${alias(from)}` : "", tabbed.has(to) ? `lhead=cluster_${alias(to)}` : ""].filter(Boolean).join(", ")
  const edge = (from: string, to: string, attrs: string) => `  ${from} -> ${to}${attrs ? ` [${attrs}]` : ""};`

  for (const entry of entries) body.push(edge("START", endpoint(entry.id), clip("", entry.id)))
  for (const [from, to] of oneWayEdges(screens, entries)) body.push(edge(endpoint(from), endpoint(to), clip(from, to)))
  body.push("}")

  return { kind: "screen_flow", section: "fixed:3.1.1", owner_kind: null, owner_id: null, puml: puml("@startdot", body, "@enddot") }
}

export const renderScreenFlow: Renderer = (spine: Spine) => {
  const screens = byId(spine.screens)
  const actorsOf = screenActorMap(spine)
  if (screens.length === 0 || !hasScreenActorLinks(actorsOf)) return [flowPart(screens, null)]

  const parts = byId(spine.actors.filter((a) => a.kind === "human"))
    .map((actor) => ({ actor, own: screens.filter((s) => actorsOf.get(s.id)?.includes(actor.id)) }))
    .filter(({ own }) => own.length > 0)
    .map(({ actor, own }) => flowPart(own, { title: screenFlowTitle(actor.name), actorName: actor.name }))

  const unassigned = screens.filter((s) => (actorsOf.get(s.id) ?? []).length === 0)
  if (unassigned.length > 0) parts.push(flowPart(unassigned, { title: UNASSIGNED_SCREENS_TITLE, actorName: null }))
  return parts
}
