/**
 * §3.1.1 Screens Flow — source_fields: `screens[].name/.flow_to/.is_popup/.tabs/.feature_id` · `features[].name/.order` ·
 * `actors[].name` + actor của màn (`screen-actors.ts`: màn → `primary_function_id` → function → use case → `actor_ids`).
 * UML 2.5 Activity Diagram có swimlane, dựng bằng SVG (hình học ở `screen-flow-layout.ts`).
 *
 * MỖI FEATURE MỘT SƠ ĐỒ (`screens[].feature_id`; màn có feature không tồn tại gom vào nhóm cuối, tên `labels.otherGroup`).
 * Nhóm quá `MAX_SCREENS_PER_DIAGRAM` màn tách đều thành nhiều hình theo hạng trong luồng; hình không qua `checkScene` tách đôi
 * tiếp. Phần đầu giữ id gốc của hình (`diagram.service.ts#assignIds`).
 *
 * Làn = actor thực hiện màn đúng như mô hình actor – use case (actor tổng quát giữ nguyên, tên làn chỉ là tên actor). Màn
 * không có actor người nào không có làn nên không vẽ — cờ `orphan_screen` bắt nó; chưa có liên kết màn ↔ actor nào (trước
 * S-4.4) ⇒ vẽ không có làn. Màn có nhiều actor không cùng cha vẫn vào làn của actor đầu tiên, cờ `screen_actor_ambiguous`
 * báo xem lại mô hình actor.
 *
 * Nút: action (chữ nhật bo góc) = màn; pop-up = action có stereotype `<<pop-up>>`; màn nhiều tab = action có dòng
 * `[tab | tab]` dưới tên. Mỗi màn vào (không có cạnh tiến vào) có một initial node, mỗi màn kết thúc (không có cạnh tiến ra
 * trong hình) có một activity final; cạnh `flow_to` trỏ sang feature khác không vẽ (màn đích không nằm trong hình này).
 * Cạnh quay lại màn trước không vẽ — điều hướng quay lại là ngầm định. `flow_to[].trigger` là nhãn trên cạnh; màn có ≥ 2 cạnh
 * ra mà một cạnh có `guard` thì rẽ nhánh qua decision node, guard in `[guard]` trên từng nhánh, nhánh không guard là `[else]`.
 * Hình không vẽ tiêu đề; `<title>` của SVG là chú thích (`section-renderer`).
 */

import { checkScene } from "../../../shared/diagram/svg-geometry.js"
import { screenLanes, hasScreenActorLinks, screenActorMap } from "../../spine/screen-actors.js"
import type { Screen, Spine } from "../../spine/spine.types.js"
import type { RenderedPart, Renderer } from "./common.js"
import { byId, compareIds, svgPart } from "./common.js"
import { DIAGRAM_LABELS, type DiagramLabels } from "./labels.js"
import { layoutScreenFlow, planFlow, type FlowDiagram, type FlowEdgeInput, type FlowLane } from "./screen-flow-layout.js"

export const MAX_SCREENS_PER_DIAGRAM = 25
export const SCREEN_FLOW_SECTION = "fixed:3.1.1"

const clean = (text: string): string => text.replace(/\s+/g, " ").trim()

const byQueueOrder = (a: Screen, b: Screen): number =>
  (a.queue_order ?? Number.MAX_SAFE_INTEGER) - (b.queue_order ?? Number.MAX_SAFE_INTEGER) || compareIds(a.id, b.id)

interface ScreenGroup {
  name: string
  screens: Screen[]
}

const groupByFeature = (spine: Spine, screens: Screen[], labels: DiagramLabels): ScreenGroup[] => {
  const features = [...spine.features].sort((a, b) => a.order - b.order || compareIds(a.id, b.id))
  const known = new Set(features.map((f) => f.id))
  const groups: ScreenGroup[] = features
    .map((f) => ({ name: clean(f.name) || f.id, screens: screens.filter((s) => s.feature_id === f.id) }))
    .filter((g) => g.screens.length > 0)
  const rest = screens.filter((s) => !known.has(s.feature_id))
  if (rest.length > 0) groups.push({ name: labels.otherGroup, screens: rest })
  return groups.map((g) => ({ ...g, screens: [...g.screens].sort(byQueueOrder) }))
}

const flowsOf = (screens: readonly Screen[]): [string, string][] => screens.flatMap((s) => s.flow_to.map((e): [string, string] => [s.id, e.to]))
const labelledFlowsOf = (screens: readonly Screen[]): FlowEdgeInput[] =>
  screens.flatMap((s) => s.flow_to.map((e) => ({ from: s.id, to: e.to, ...(e.trigger ? { trigger: e.trigger } : {}), ...(e.guard ? { guard: e.guard } : {}) })))
const popupsOf = (screens: readonly Screen[]): Set<string> => new Set(screens.filter((s) => s.is_popup).map((s) => s.id))

/** Cắt `screens` (đã theo thứ tự ưu tiên) thành `parts` phần đều nhau theo hạng trong luồng, rồi trả lại thứ tự ưu tiên trong từng phần. */
const splitScreens = (screens: Screen[], parts: number): Screen[][] => {
  const plan = planFlow(screens.map((s) => s.id), popupsOf(screens), flowsOf(screens))
  const position = new Map(screens.map((s, i) => [s.id, i]))
  const ranked = [...screens].sort((a, b) => plan.rank.get(a.id)! - plan.rank.get(b.id)! || position.get(a.id)! - position.get(b.id)!)
  const size = Math.ceil(ranked.length / parts)
  return Array.from({ length: parts }, (_, i) => ranked.slice(i * size, (i + 1) * size).sort(byQueueOrder)).filter((p) => p.length > 0)
}

const meta = (): Pick<RenderedPart, "kind" | "section" | "owner_kind" | "owner_id"> => ({ kind: "screen_flow", section: SCREEN_FLOW_SECTION, owner_kind: null, owner_id: null })

/** Mọi hình luồng màn của Spine theo thứ tự trong tài liệu (feature theo `order`): tiêu đề + dữ liệu hình. */
export const partitionScreenFlow = (spine: Spine, labels: DiagramLabels = DIAGRAM_LABELS.en): { title: string; diagram: FlowDiagram }[] => {
  const lanes = screenLanes(spine)
  const linked = hasScreenActorLinks(screenActorMap(spine))
  const actorName = new Map(spine.actors.map((a) => [a.id, clean(a.name) || a.id]))
  const drawn = byId(spine.screens).filter((s) => !linked || lanes.get(s.id) !== null)

  const diagramOf = (screens: Screen[]): FlowDiagram => {
    const plan = planFlow(screens.map((s) => s.id), popupsOf(screens), flowsOf(screens))
    const position = new Map(screens.map((s, i) => [s.id, i]))
    const laneIds: string[] = []
    if (linked) {
      for (const s of [...screens].sort((a, b) => plan.rank.get(a.id)! - plan.rank.get(b.id)! || position.get(a.id)! - position.get(b.id)!)) {
        const actorId = lanes.get(s.id)!.actorId
        if (!laneIds.includes(actorId)) laneIds.push(actorId)
      }
    }
    const flowLanes: FlowLane[] = laneIds.map((id) => ({ id, name: actorName.get(id) ?? id }))
    return {
      lanes: flowLanes,
      nodes: screens.map((s) => ({ id: s.id, name: s.name, lane: linked ? laneIds.indexOf(lanes.get(s.id)!.actorId) : 0, popup: s.is_popup, tabs: s.tabs })),
      edges: labelledFlowsOf(screens),
      popupLabel: labels.popup,
      elseLabel: labels.elseGuard
    }
  }
  const fits = (screens: Screen[]): boolean => checkScene(layoutScreenFlow(diagramOf(screens)), { allowBends: true }).length === 0

  /** Tách đôi tới khi hình qua `checkScene` (không đạt bố cục thì tách hình); một màn lẻ thì dừng. */
  const refine = (screens: Screen[]): Screen[][] => {
    if (screens.length < 2 || fits(screens)) return [screens]
    return splitScreens(screens, 2).flatMap(refine)
  }

  const out: { title: string; diagram: FlowDiagram }[] = []
  for (const group of groupByFeature(spine, drawn, labels)) {
    const parts = group.screens.length > MAX_SCREENS_PER_DIAGRAM ? splitScreens(group.screens, Math.ceil(group.screens.length / MAX_SCREENS_PER_DIAGRAM)) : [group.screens]
    const final = parts.flatMap(refine)
    final.forEach((screens, i) => {
      const title = labels.screensFlowTitle(final.length > 1 ? `${group.name} (${i + 1}/${final.length})` : group.name)
      out.push({ title, diagram: diagramOf(screens) })
    })
  }
  return out
}

export const renderScreenFlow: Renderer = (spine, _ownerId, labels = DIAGRAM_LABELS.en) =>
  partitionScreenFlow(spine, labels).map(({ title, diagram }) => svgPart(layoutScreenFlow(diagram), { allowBends: true }, meta(), title))
