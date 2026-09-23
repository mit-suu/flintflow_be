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
  - "actors[].name/.kind/.flows_in/.flows_out"
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
- Actors form a ring around the circle, sorted by id: the first goes left, the second right, the rest alternate between the top and bottom rows. PlantUML places the TARGET relative to the SOURCE, so an edge into the system uses `-right-/-down-/-left-/-up->` while an edge out of it uses `-left-/-up-/-right-/-down->` for the same four positions.
- Exactly ONE edge per actor. With both `flows_in` and `flows_out` it is a double-headed `<actor> <-<dir>-> SYSTEM_` whose label has one line per direction, each prefixed by the arrow glyph for that direction at that position (`→ ←` left, `← →` right, `↓ ↑` top, `↑ ↓` bottom), `flows_in` first. Two separate arrows would look lopsided: Graphviz always puts a label to the RIGHT of its edge, so the left edge of a pair gets its label between the two edges.
- One direction only ⇒ a plain arrow: `<actor> --> SYSTEM_` for `flows_in`, `SYSTEM_ --> <actor>` for `flows_out`, no glyph in the label.
- No step skill writes `flows_in`/`flows_out`: they are filled by hand or through the change conversation, so adding them never changes what any other step drafts. Until then every edge falls back to use case names.
- Labels: at most 3 flow names per direction then `+ N more` — joined by `, ` on the double-headed edge, one per line on a single-direction edge. An actor with neither list gets ONE arrow labelled with the names of the use cases whose `actor_ids` contain it (sorted by use case id), pointing into the system for `human`/`time` and out of it for `system`. Neither flows nor use cases ⇒ no label.
- No `skinparam linetype`: the default splines keep a lone edge near-straight and curve the two edges of a pair smoothly. `polyline` kinks the second edge of a pair, `ortho` overlaps labels. `nodesep 45` keeps the two labels of one actor apart.
- Elements are sorted by id, so the same Spine always yields the same text.

## When it re-renders

The `source_hash` covers `project.name`, `actors[].name/.kind/.flows_in/.flows_out` and `use_cases[].name/.actor_ids`. Editing any description does not re-render. S-3.1 adds human actors and use cases, so the diagram drawn at S-2.5 goes stale and S-3.6 re-renders it.
