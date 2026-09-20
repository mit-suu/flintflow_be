---
skill_id: context
kind: renderer
version: 1.0.0
description: "S-2.5 System Context Diagram (level-0 data flow: system circle, actor rectangles)"
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 4096
temperature: 0.1
reads:
  - "project.name"
  - "actors[].name/.kind"
  - "use_cases[].name/.actor_ids"
writes:
  - "diagrams[kind=context]"
output_schema: puml
language: en
stub: false
---
# Context

> The renderer is deterministic code: `src/modules/diagram/renderers/context.renderer.ts`. This skill documents the output and is loaded with `action/plantuml-conventions` only by the `render_fix` call.

- Step: S-2.5 System Context Diagram (re-rendered at S-3.6) · Section: `fixed:1` · Output: `puml`

## Output

- Level-0 data-flow style: the system is one large `usecase` ellipse in the centre (label `project.name`, alias `SYSTEM_`).
- One plain `rectangle` per actor (every kind, no stereotype), alias = actor id.
- One directed edge per actor: `human`/`time` → `<actor id> --> SYSTEM_` (left side); `system` → `SYSTEM_ --> <actor id>` (right side).
- Edge label = names of the use cases whose `actor_ids` contain the actor, sorted by use case id, one per line, at most 3 then `+ N more`. No use case yet ⇒ no label (the Spine has no separate interaction label).
- `skinparam linetype polyline` keeps edges straight; `ortho` overlaps labels.
- Elements are sorted by id, so the same Spine always yields the same text.

## When it re-renders

The `source_hash` covers `project.name`, `actors[].name/.kind` and `use_cases[].name/.actor_ids`. Editing any description does not re-render. S-3.1 adds human actors and use cases, so the diagram drawn at S-2.5 goes stale and S-3.6 re-renders it.
