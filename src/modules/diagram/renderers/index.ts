/**
 * Đường vẽ diagram (Phases §7.1): projection Spine → renderer thuần → `diagrams[]`. Hai engine theo `part.format`
 * (FLF-339): `puml` ⇒ text `.puml` → compile-check → PlantUML self-host; `svg` ⇒ `Scene` → `checkScene` → resvg
 * (`common.ts#svgPart`). `source_hash` = `renderedDiagramHash` (dữ liệu + engine của kind). Không có sequence diagram.
 */

import type { Diagram, Spine } from "../../spine/spine.types.js"
import type { RenderContext } from "../../../shared/diagram/erd-notation.js"
import { renderedDiagramHash } from "../../spine/source-hash.js"
import type { DiagramKind, RenderedPart, Renderer } from "./common.js"
import { byId } from "./common.js"
import { renderContext } from "./context.renderer.js"
import { renderUseCase } from "./usecase.renderer.js"
import { renderScreenFlow } from "./screen-flow.renderer.js"
import { renderErd } from "./erd.renderer.js"
import { renderClass } from "./class.renderer.js"
import { renderStateMachine } from "./state-machine.renderer.js"
import { renderScreenLayout } from "./screen-layout.renderer.js"

export type { DiagramKind, RenderedPart } from "./common.js"

export const DIAGRAM_KINDS: readonly DiagramKind[] = Object.freeze(["context", "usecase", "screen_flow", "erd", "class", "state_machine", "screen_layout"])

export const RENDERERS: Readonly<Record<DiagramKind, Renderer>> = Object.freeze({
  context: renderContext,
  usecase: renderUseCase,
  screen_flow: renderScreenFlow,
  erd: renderErd,
  class: renderClass,
  state_machine: renderStateMachine,
  screen_layout: renderScreenLayout
})

export interface RenderTarget {
  kind: DiagramKind
  /** Chỉ `screen_layout`: id màn. `class` (mọi feature) và `state_machine` (mọi entity) vẽ trong một target (owner_id null); chủ của từng hình là feature. */
  owner_id: string | null
}

/** Target vẽ lại một hình đã có: chỉ `screen_layout` đi theo chủ (màn); mọi kind khác — kể cả `class` — vẽ cả kind. */
export const targetOfDiagram = (d: Pick<Diagram, "kind" | "owner_id">): RenderTarget => ({ kind: d.kind, owner_id: d.kind === "screen_layout" ? d.owner_id : null })

export interface RenderedDiagramPart extends RenderedPart {
  /** Hash `source_fields` (T09 `source-hash.ts`) — `diagram_stale` so với giá trị này. */
  source_hash: string
}

export const renderKind = (spine: Spine, kind: DiagramKind, ownerId: string | null = null, context: RenderContext = {}): RenderedDiagramPart[] =>
  RENDERERS[kind](spine, ownerId, undefined, context).map((part) => ({
    ...part,
    source_hash: renderedDiagramHash(spine, { kind, owner_id: part.owner_id }, undefined, context)
  }))

/** Wireframe chỉ cho màn cốt lõi (`signed_off`) có primary function (Phases §7.2). */
export const layoutOwners = (spine: Spine): string[] =>
  byId(spine.screens.filter((s) => s.detail_status === "signed_off" && s.primary_function_id !== null)).map((s) => s.id)

export const allTargets = (spine: Spine): RenderTarget[] => [
  { kind: "context", owner_id: null },
  { kind: "usecase", owner_id: null },
  { kind: "screen_flow", owner_id: null },
  { kind: "erd", owner_id: null },
  { kind: "class", owner_id: null },
  { kind: "state_machine", owner_id: null },
  ...layoutOwners(spine).map((id) => ({ kind: "screen_layout" as const, owner_id: id }))
]
