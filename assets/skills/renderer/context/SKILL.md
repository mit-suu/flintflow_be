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
- Actors form a ring around the circle, sorted by id. Two-way actors go to the TOP row first, at most 4 (`MAX_TOP_PAIRS`); the rest go to the bottom row. They never take the left/right slots: a horizontal pair cannot split its labels to two sides. One-way actors take left, right, then whichever of top/bottom holds fewer actors (tie ⇒ bottom), so the top row stays for pairs. Reason: Graphviz bows both arrows of a top-row pair, but for a pair sitting straight under the circle it keeps the in-arrow straight. PlantUML places the TARGET relative to the SOURCE, so an edge into the system uses `-right-/-down-/-left-/-up->` while an edge out of it uses `-left-/-up-/-right-/-down->` for the same four positions.
- An actor with both `flows_in` and `flows_out` gets TWO separate arrows whose labels sit on OPPOSITE sides: the `flows_in` label outside on the left, the `flows_out` label outside on the right. Graphviz always puts a label to the RIGHT of its edge, so the pair is emitted as five lines: a transparent carrier holding the `flows_in` label (`<actor> -[#transparent]<dir>-> SYSTEM_ : <flows_in>`), the unlabelled in-arrow, a transparent spacer (`<actor> -[#transparent]<dir>- SYSTEM_`), the out-arrow `SYSTEM_ -<dir>-> <actor> : <flows_out>`, and the spacer again. The spacers put the middle of the edge bundle between the two arrows, so Graphviz centres the actor there and bows both arrows alike; without them the in-arrow stays straight.
- One direction only ⇒ a plain arrow: `<actor> --> SYSTEM_` for `flows_in`, `SYSTEM_ --> <actor>` for `flows_out`, no glyph in the label.
- No step skill writes `flows_in`/`flows_out`: they are filled by hand or through the change conversation, so adding them never changes what any other step drafts. Until then every edge falls back to use case names.
- Labels: at most 3 flow names per direction, one per line, then `+ N more`. An actor with neither list gets ONE arrow labelled with the names of the use cases whose `actor_ids` contain it (sorted by use case id), pointing into the system for `human`/`time` and out of it for `system`. Neither flows nor use cases ⇒ no label.
- No `skinparam linetype`: the default splines keep edges smooth; `polyline` kinks the second edge of a pair, `ortho` overlaps labels. `nodesep 20` is deliberately small: the carrier label sits one `nodesep` away from the in-arrow, so a larger value makes the `flows_in` label drift off its arrow. `-[hidden]-` spacers and the ELK engine were tried and rejected (spacers tangle the pairs in a dense ring; ELK crashes on the PlantUML server).
- The system label is padded with 4 blank lines above/below and 8 spaces each side, so the ellipse is big enough that top-row edges do not run through the labels of the left/right actors. Check on the real PlantUML server (DejaVu font is wider than a local Java render).
- Elements are sorted by id, so the same Spine always yields the same text.

## When it re-renders

The `source_hash` covers `project.name`, `actors[].name/.kind/.flows_in/.flows_out` and `use_cases[].name/.actor_ids`. Editing any description does not re-render. S-3.1 adds human actors and use cases, so the diagram drawn at S-2.5 goes stale and S-3.6 re-renders it.
