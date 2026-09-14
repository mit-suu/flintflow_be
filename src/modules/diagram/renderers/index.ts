/**
 * Một đường duy nhất cho diagram (Phases §7.1): projection Spine → `.puml` (renderer thuần) →
 * compile-check → PlantUML self-host → `diagrams[]`. Không có sequence diagram.
 */

import type { Spine } from "../../spine/spine.types.js"
import { computeSourceHash } from "../../spine/source-hash.js"
import type { DiagramKind, RenderedPart, Renderer } from "./common.js"
import { byId } from "./common.js"
import { renderContext } from "./context.renderer.js"
import { renderUseCase } from "./usecase.renderer.js"
import { renderScreenFlow } from "./screen-flow.renderer.js"
import { renderErd } from "./erd.renderer.js"
import { renderScreenLayout } from "./screen-layout.renderer.js"

export type { DiagramKind, RenderedPart } from "./common.js"

export const DIAGRAM_KINDS: readonly DiagramKind[] = Object.freeze(["context", "usecase", "screen_flow", "erd", "screen_layout"])

export const RENDERERS: Readonly<Record<DiagramKind, Renderer>> = Object.freeze({
  context: renderContext,
  usecase: renderUseCase,
  screen_flow: renderScreenFlow,
  erd: renderErd,
  screen_layout: renderScreenLayout
})

export interface RenderTarget {
  kind: DiagramKind
  /** Chỉ `screen_layout`: id màn. */
  owner_id: string | null
}

export interface RenderedDiagramPart extends RenderedPart {
  /** Hash `source_fields` (T09 `source-hash.ts`) — `diagram_stale` so với giá trị này. */
  source_hash: string
}

export const renderKind = (spine: Spine, kind: DiagramKind, ownerId: string | null = null): RenderedDiagramPart[] =>
  RENDERERS[kind](spine, ownerId).map((part) => ({
    ...part,
    source_hash: computeSourceHash(spine, { kind, owner_id: part.owner_id })
  }))

/** Wireframe chỉ cho màn cốt lõi (`signed_off`) có primary function (Phases §7.2). */
export const layoutOwners = (spine: Spine): string[] =>
  byId(spine.screens.filter((s) => s.detail_status === "signed_off" && s.primary_function_id !== null)).map((s) => s.id)

export const allTargets = (spine: Spine): RenderTarget[] => [
  { kind: "context", owner_id: null },
  { kind: "usecase", owner_id: null },
  { kind: "screen_flow", owner_id: null },
  { kind: "erd", owner_id: null },
  ...layoutOwners(spine).map((id) => ({ kind: "screen_layout" as const, owner_id: id }))
]
