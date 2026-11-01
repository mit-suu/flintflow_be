/**
 * §3.1.1 Screens Flow — source_fields: `screens[].name/.flow_to[].to/.is_popup/.tabs/.feature_id/.queue_order` ·
 * `features[].name/.order` · actor người dùng màn (`screen-actors.ts`).
 * Đúng ký pháp hình mẫu §3.1.1 của template SRS FPT ("draw the Screens Flow for the system"), dựng bằng SVG (hình học ở
 * `screen-flow-layout.ts`): màn = chữ nhật, pop-up = ô-van, màn nhiều tab = khung chứa các tab, mũi tên tam giác đặc.
 * Ô vàng của template ⇒ nền `#7ACFF5` cho màn dùng chung (`sharedScreenIds`), màn còn lại nền trắng.
 *
 * MỘT HÌNH CHO CẢ HỆ THỐNG. Quá `MAX_SCREENS_PER_DIAGRAM` màn hoặc không qua `checkScene` ⇒ chia theo feature nguyên vẹn
 * (`features[].order`; màn có feature không tồn tại gom vào nhóm cuối), gói tham lam tới `MAX_SCREENS_PER_DIAGRAM` màn mỗi
 * hình; một feature tự nó quá ngưỡng / không qua bộ kiểm thì tách đôi theo hạng trong luồng. Cạnh sang hình khác không vẽ.
 * Phần đầu giữ id gốc của hình (`diagram.service.ts#assignIds`).
 *
 * Vẽ MỌI màn (template vẽ toàn hệ thống), kể cả màn chưa nối được actor nào — cờ `orphan_screen` nhắc sửa dữ liệu; ẩn màn
 * đó làm màn con của nó thành gốc trơ trọi. Cạnh quay lại màn
 * trước không vẽ — điều hướng quay lại là ngầm định. Trigger / guard của `flow_to` không vẽ (template không ghi nhãn cạnh).
 * Hình không vẽ tiêu đề; `<title>` của SVG là chú thích (`section-renderer`).
 */

import { checkScene } from "../../../shared/diagram/svg-geometry.js"
import { sharedScreenIds } from "../../spine/screen-actors.js"
import type { Screen, Spine } from "../../spine/spine.types.js"
import type { RenderedPart, Renderer } from "./common.js"
import { byId, compareIds, svgPart } from "./common.js"
import { DIAGRAM_LABELS, type DiagramLabels } from "./labels.js"
import { layoutScreenFlow, planFlow, type FlowDiagram } from "./screen-flow-layout.js"

export const MAX_SCREENS_PER_DIAGRAM = 40
export const SCREEN_FLOW_SECTION = "fixed:3.1.1"

const byQueueOrder = (a: Screen, b: Screen): number =>
  (a.queue_order ?? Number.MAX_SAFE_INTEGER) - (b.queue_order ?? Number.MAX_SAFE_INTEGER) || compareIds(a.id, b.id)

/** Màn theo feature (`features[].order`, rồi id); màn có feature không tồn tại gom vào nhóm cuối. */
const groupByFeature = (spine: Spine, screens: Screen[]): Screen[][] => {
  const features = [...spine.features].sort((a, b) => a.order - b.order || compareIds(a.id, b.id))
  const known = new Set(features.map((f) => f.id))
  const groups = features.map((f) => screens.filter((s) => s.feature_id === f.id)).filter((g) => g.length > 0)
  const rest = screens.filter((s) => !known.has(s.feature_id))
  if (rest.length > 0) groups.push(rest)
  return groups
}

const flowsOf = (screens: readonly Screen[]): [string, string][] => screens.flatMap((s) => s.flow_to.map((e): [string, string] => [s.id, e.to]))
const popupsOf = (screens: readonly Screen[]): Set<string> => new Set(screens.filter((s) => s.is_popup).map((s) => s.id))

/** Cắt `screens` (đã theo thứ tự ưu tiên) làm đôi theo hạng trong luồng, trả lại thứ tự ưu tiên trong từng nửa. */
const halve = (screens: Screen[]): Screen[][] => {
  const plan = planFlow(screens.map((s) => s.id), popupsOf(screens), flowsOf(screens))
  const position = new Map(screens.map((s, i) => [s.id, i]))
  const ranked = [...screens].sort((a, b) => plan.rank.get(a.id)! - plan.rank.get(b.id)! || position.get(a.id)! - position.get(b.id)!)
  const size = Math.ceil(ranked.length / 2)
  return [ranked.slice(0, size), ranked.slice(size)].map((p) => p.sort(byQueueOrder)).filter((p) => p.length > 0)
}

const meta = (): Pick<RenderedPart, "kind" | "section" | "owner_kind" | "owner_id"> => ({ kind: "screen_flow", section: SCREEN_FLOW_SECTION, owner_kind: null, owner_id: null })

/** Mọi hình luồng màn của Spine theo thứ tự trong tài liệu: tiêu đề + dữ liệu hình (thường đúng một hình). */
export const partitionScreenFlow = (spine: Spine, labels: DiagramLabels = DIAGRAM_LABELS.en): { title: string; diagram: FlowDiagram }[] => {
  const shared = sharedScreenIds(spine)
  const drawn = byId(spine.screens).sort(byQueueOrder)
  if (drawn.length === 0) return []

  const diagramOf = (screens: Screen[]): FlowDiagram => ({
    nodes: screens.map((s) => ({ id: s.id, name: s.name, popup: s.is_popup, tabs: s.tabs, shared: shared.has(s.id) })),
    edges: flowsOf(screens)
  })
  const fits = (screens: Screen[]): boolean =>
    screens.length <= MAX_SCREENS_PER_DIAGRAM && checkScene(layoutScreenFlow(diagramOf(screens)), { allowBends: true }).length === 0
  /** Phần không vừa: nhiều feature ⇒ tách theo feature trước; một feature ⇒ tách đôi theo hạng; một màn lẻ thì dừng. */
  const refine = (screens: Screen[]): Screen[][] => {
    if (screens.length < 2 || fits(screens)) return [screens]
    const groups = groupByFeature(spine, screens)
    return (groups.length > 1 ? groups : halve(screens)).flatMap(refine)
  }

  let parts: Screen[][]
  if (fits(drawn)) parts = [drawn]
  else {
    parts = []
    let current: Screen[] = []
    for (const group of groupByFeature(spine, drawn)) {
      if (current.length > 0 && current.length + group.length > MAX_SCREENS_PER_DIAGRAM) {
        parts.push(current)
        current = []
      }
      current.push(...group)
    }
    if (current.length > 0) parts.push(current)
    parts = parts.map((p) => p.sort(byQueueOrder)).flatMap(refine)
  }
  return parts.map((screens, i) => ({ title: labels.screensFlowTitle(parts.length > 1 ? `${i + 1}/${parts.length}` : undefined), diagram: diagramOf(screens) }))
}

export const renderScreenFlow: Renderer = (spine, _ownerId, labels = DIAGRAM_LABELS.en) =>
  partitionScreenFlow(spine, labels).map(({ title, diagram }) => svgPart(layoutScreenFlow(diagram), { allowBends: true }, meta(), title))
