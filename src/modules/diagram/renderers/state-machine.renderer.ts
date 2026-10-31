/**
 * State machine diagram — vòng đời của entity (UML 2.5 State Machine). source_fields: `entities[].name/.states/.transitions`
 * (srs-spine §7.1). Dựng bằng SVG (hình học ở `state-machine-layout.ts`).
 *
 * MỖI ENTITY CÓ TRẠNG THÁI MỘT HÌNH (`owner_kind = entity`, `owner_id` = id entity, `section = fixed:3.1.5`, cạnh mô tả
 * entity). Entity không có `states` ⇒ không có hình (không bịa vòng đời). Chỉ vẽ điều Spine ghi: state, initial, final,
 * transition `event [guard] / action`; transition tự thân thành internal transition trong state. Hình không chia nhỏ
 * (một vòng đời là một đồ thị); không tìm được bố cục hợp lệ thì báo lỗi bố cục thay vì ra hình sai.
 */

import { Scene } from "../../../shared/diagram/svg-scene.js"
import type { Entity, EntityTransition } from "../../spine/spine.types.js"
import type { RenderedPart, Renderer } from "./common.js"
import { byId, svgPart } from "./common.js"
import { DIAGRAM_LABELS } from "./labels.js"
import { layoutStateMachine, type StateMachineInput } from "./state-machine-layout.js"

const clean = (text: string | undefined): string => (text ?? "").replace(/\s+/g, " ").trim()

/** Nhãn UML `event [guard] / action` (guard, action bỏ trống thì bỏ phần đó). */
export const transitionLabel = (t: Pick<EntityTransition, "event" | "guard" | "action">): string => {
  const guard = clean(t.guard)
  const action = clean(t.action)
  return [clean(t.event), guard ? `[${guard}]` : "", action ? `/ ${action}` : ""].filter((part) => part !== "").join(" ")
}

/** Dữ liệu vẽ của một entity có trạng thái. */
export const stateMachineInput = (entity: Entity): StateMachineInput => {
  const transitions = entity.transitions ?? []
  return {
    states: (entity.states ?? []).map((s) => ({
      id: s.id,
      name: clean(s.name) || s.id,
      initial: s.initial === true,
      final: s.final === true,
      internal: transitions.filter((t) => t.from === s.id && t.to === s.id).map(transitionLabel)
    })),
    transitions: transitions.filter((t) => t.from !== t.to).map((t) => ({ from: t.from, to: t.to, text: transitionLabel(t) }))
  }
}

const meta = (entityId: string): Pick<RenderedPart, "kind" | "section" | "owner_kind" | "owner_id"> => ({
  kind: "state_machine",
  section: "fixed:3.1.5",
  owner_kind: "entity",
  owner_id: entityId
})

export const renderStateMachine: Renderer = (spine, _ownerId, labels = DIAGRAM_LABELS.en) =>
  byId(spine.entities)
    .filter((e) => (e.states ?? []).length > 0)
    .map((entity) => {
      const title = labels.stateMachineTitle(clean(entity.name) || entity.id)
      const scene = layoutStateMachine(stateMachineInput(entity))
      if (scene) return svgPart(scene, { allowBends: false }, meta(entity.id), title)
      const empty = svgPart(new Scene(), { allowBends: false }, meta(entity.id), title)
      return { ...empty, issues: [{ rule: "line_overlap" as const, ids: [], message: `State machine "${entity.name}": không tìm được bố cục không chồng / xuyên hình` }] }
    })

