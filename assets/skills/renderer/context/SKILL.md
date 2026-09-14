---
skill_id: context
kind: renderer
version: 1.0.0
description: "S-2.5 System Context Diagram (component / rectangle)"
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 4096
temperature: 0.1
reads:
  - "project.name"
  - "actors[kind≠human].name"
writes:
  - "diagrams[kind=context]"
output_schema: puml
language: en
stub: true
---
# Context

> The renderer is deterministic code: `src/modules/diagram/renderers/context.renderer.ts`. This skill documents the output and is loaded with `action/plantuml-conventions` only by the `render_fix` call. `stub: true` stays until the T03 asset test stops requiring it (XREQ T10→T03).

- Step: S-2.5 System Context Diagram · Section: `fixed:1` · Output: `puml`

## Output

- One `rectangle` for the system (label `project.name`, alias `SYSTEM_`).
- One `rectangle` per actor with `kind ≠ human`, alias = actor id, stereotype `<<system>>` or `<<time>>`.
- One undirected edge `SYSTEM_ -- <actor id>` per external actor. Edges are **unlabelled**, because interaction labels are not `source_fields` and would make `source_hash` meaningless.
- Elements are sorted by id, so the same Spine always yields the same text.

## When it re-renders

The `source_hash` covers `project.name` plus `actors[kind≠human].name`. Renaming a human actor or editing any description does not re-render.
