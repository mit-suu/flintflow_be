/**
 * Sơ đồ activity (UML 2.5 Activity Diagram) — luồng xử lý của một use case (FLF-390). source_fields:
 * `use_cases[].name/.activity_nodes/.activity_flows` · `actors[].name` của các làn. Dựng bằng SVG (hình học ở
 * `activity-layout.ts`, lấy bố cục swimlane của FLF-340).
 *
 * MỖI USE CASE CÓ `activity_nodes` MỘT HÌNH (`owner_kind = use_case`, `owner_id` = id use case). Hình nằm trong phần chức
 * năng: `section = feature:<id>` của tính năng chứa use case (`featureOfUseCase`), chưa có tính năng ⇒ `fixed:2.2.2` (đặc tả
 * use case). Use case không có nút ⇒ không có hình (không bịa luồng từ chữ) — mẫu FPT chỉ có khi người dùng yêu cầu.
 *
 * Chỉ vẽ điều Spine ghi: initial, final, action, decision / merge, fork / join, control flow (guard trong ngoặc vuông).
 * Làn = `lane` của nút (id actor ⇒ tên actor; `system` ⇒ "System"). Nút không ghi làn (initial, decision…) vào làn của nút
 * trước nó theo luồng, không có thì nút sau. Không nút nào có làn ⇒ không vẽ khung làn. Hình không vẽ tiêu đề; `<title>`
 * của SVG là chú thích (`section-renderer`).
 */

import { Scene } from "../../../shared/diagram/svg-scene.js"
import { SYSTEM_LIFELINE } from "../../spine/spine.schema.js"
import type { Spine, UseCase } from "../../spine/spine.types.js"
import type { RenderedPart, Renderer } from "./common.js"
import { byId, svgPart } from "./common.js"
import { DIAGRAM_LABELS, type DiagramLabels } from "./labels.js"
import { layoutActivity, type ActivityLane, type ActivityLayoutInput } from "./activity-layout.js"
import { featureOfUseCase } from "./usecase.renderer.js"

/** Use case chưa thuộc tính năng nào ⇒ hình ở mục đặc tả use case. */
export const ACTIVITY_FALLBACK_SECTION = "fixed:2.2.2"

/** Mục in sơ đồ activity của use case: tính năng chứa nó (phần chức năng), không có ⇒ mục đặc tả use case. */
export const activitySectionOf = (uc: UseCase, spine: Pick<Spine, "functions" | "features">): string => {
  const feature = featureOfUseCase(uc, spine)
  return feature ? `feature:${feature}` : ACTIVITY_FALLBACK_SECTION
}

const clean = (text: string | null | undefined): string => (text ?? "").replace(/\s+/g, " ").trim()

/** Làn của từng nút: làn ghi trong dữ liệu, không có thì kế thừa nút trước (rồi nút sau) theo control flow. */
const resolveLanes = (uc: UseCase): Map<string, string | null> => {
  const nodes = uc.activity_nodes ?? []
  const flows = uc.activity_flows ?? []
  const lane = new Map<string, string | null>(nodes.map((n) => [n.id, typeof n.lane === "string" && n.lane !== "" ? n.lane : null]))
  for (let changed = true; changed; ) {
    changed = false
    for (const n of nodes) {
      if (lane.get(n.id) !== null) continue
      const before = flows.filter((f) => f.to === n.id).map((f) => lane.get(f.from) ?? null).find((l) => l !== null)
      const after = flows.filter((f) => f.from === n.id).map((f) => lane.get(f.to) ?? null).find((l) => l !== null)
      const got = before ?? after ?? null
      if (got !== null) {
        lane.set(n.id, got)
        changed = true
      }
    }
  }
  return lane
}

/** Dữ liệu vẽ của một use case có luồng xử lý. */
export const activityInput = (spine: Spine, uc: UseCase, labels: DiagramLabels = DIAGRAM_LABELS.en): ActivityLayoutInput => {
  const nodes = uc.activity_nodes ?? []
  const lanes = resolveLanes(uc)
  const actorName = new Map(spine.actors.map((a) => [a.id, clean(a.name) || a.id]))
  const order: string[] = []
  for (const n of nodes) {
    const l = lanes.get(n.id)
    if (l && !order.includes(l)) order.push(l)
  }
  const flowLanes: ActivityLane[] = order.map((id) => ({ id, name: id === SYSTEM_LIFELINE ? labels.system : (actorName.get(id) ?? id) }))
  return {
    lanes: flowLanes,
    nodes: nodes.map((n) => {
      const l = lanes.get(n.id)
      return { id: n.id, kind: n.kind, name: clean(n.name), lane: l ? order.indexOf(l) : 0 }
    }),
    flows: (uc.activity_flows ?? []).map((f) => ({ from: f.from, to: f.to, guard: clean(f.guard) }))
  }
}

const meta = (spine: Spine, uc: UseCase): Pick<RenderedPart, "kind" | "section" | "owner_kind" | "owner_id"> => ({
  kind: "activity",
  section: activitySectionOf(uc, spine),
  owner_kind: "use_case",
  owner_id: uc.id
})

export const renderActivity: Renderer = (spine, _ownerId, labels = DIAGRAM_LABELS.en) =>
  byId(spine.use_cases)
    .filter((u) => (u.activity_nodes ?? []).length > 0)
    .map((uc) => {
      const title = labels.activityTitle(clean(uc.name) || uc.id)
      try {
        return svgPart(layoutActivity(activityInput(spine, uc, labels)), { allowBends: true }, meta(spine, uc), title)
      } catch (err) {
        const empty = svgPart(new Scene(), { allowBends: true }, meta(spine, uc), title)
        return { ...empty, issues: [{ rule: "line_overlap" as const, ids: [], message: `Activity "${uc.name}": không dựng được bố cục (${(err as Error).message})` }] }
      }
    })
