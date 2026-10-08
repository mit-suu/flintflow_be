---
skill_id: context
kind: renderer
version: 2.1.0
description: "S-2.5 System Context Diagram (level-0 data flow: grey system circle, actor rectangles ringed by role, black and white)"
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 4096
temperature: 0.1
reads:
  - "project.system_name ?? project.name"
  - "actors[].name/.kind/.flows_in/.flows_out"
writes:
  - "diagrams[kind=context]"
output_schema: puml
language: en
stub: false
---
# Context

> The renderer is deterministic code: `src/modules/diagram/renderers/context.renderer.ts` (geometry in `context-layout.ts`). This skill documents the output and is loaded with `action/plantuml-conventions` only by the `render_fix` call.

- Step: S-2.5 System Context Diagram (re-rendered at S-3.6) · Section: `fixed:1` · Output: `puml`

## Output

- Level-0 data-flow diagram (context diagram) rendered as Graphviz DOT inside `@startdot` / `@enddot`. One process only: the whole system is a true circle (`shape=circle`, equal width/height) in the centre, label `project.system_name ?? project.name`, alias `SYSTEM_`, default radius 100 points. External entities are plain boxes (every kind, no stereotype), alias = actor id. No data stores, no internal processes, no flows between external entities.
- Black and white with one grey: black strokes, arrows and text; white actor boxes; the system circle filled `lightgray`; generic `sans-serif` (18 system, 14 actors, 12 labels); no shadows, no other colours.
- Actors ring the circle by ROLE (`sector` attribute): `human` on the left (`west`), `system` on the right (`east`), `time` below (`south`); `north` is used only when a column overflows. One role only ⇒ split into the two columns. The bottom row holds at most 2 narrow actors; the rest join the shorter column.
- Every `flows_in` item (actor → system) and every `flows_out` item (system → actor) is its OWN arrow with exactly ONE label. An actor may be one-way: draw only the arrows that exist; never pair lists by index and never invent a counterpart (`Response to …`, `Acknowledgement of …`). The diagram as a whole always has at least one inbound AND one outbound arrow.
- Every arrow carries data — no unlabelled arrows, no `+ N more`. More than 3 items in one direction ⇒ the first 2 plus a third arrow whose label joins the rest with `, `. The Spine keeps every exchange.
- Missing Spine data only (the content skills require real flows): an actor with no flows gets ONE fallback arrow by kind — `human` in `user input`, `time` in `scheduled trigger`, `system` out `service request`. If the whole diagram is still one-way, the first actor by kind (human → system → time for a missing outbound, system → human → time for a missing inbound) gets `processing result` / `service request` / `job status` out, or `user input` / `service response` / `scheduled trigger` in. Never label with use case names (they are actions, not data).
- Each arrow is a straight leg from the actor box (long enough to hold its label) followed by one convex cubic into the circle: no S bends, never inside the circle, arrows of one sector never cross. The label sits on its own straight leg on a borderless white HTML table (`BGCOLOR="white"`, escape `&`, `<`, `>`, `<BR/>` for wrapping only).
- `layout=nop2`, `pin=true`, `overlap=true`, `splines=true` keep the computed geometry. Node `pos`, edge `pos` and label `lp` are in POINTS; node width/height in inches. Zero-size invisible point nodes pin each arrow end to the borders. Edge attributes `actor_id`, `flow` (`in`|`out`) and `flow_index` identify the exchange; every arrow has `label` and `lp`.
- Elements are sorted by id, so the same Spine always yields the same text.

## When it re-renders

The `source_hash` covers `project.system_name ?? project.name`, `actors[].name/.kind/.flows_in/.flows_out` and `use_cases[].name/.actor_ids` (use cases no longer appear on the diagram; they only cause a harmless extra re-render). Editing any description does not re-render. S-3.1 adds human actors, so the diagram drawn at S-2.5 goes stale and S-3.6 re-renders it.
