---
skill_id: context
kind: renderer
version: 3.0.0
description: "S-2.5 System Context Diagram (level-0 data flow, Yourdon/DeMarco: one system circle, one box per external actor, one straight labelled arrow per data flow)"
provider: anthropic
aiModel: claude-haiku-5-5
maxTokens: 4096
temperature: 0.1
reads:
  - "project.system_name ?? project.name"
  - "actors[].name/.kind/.flows_in/.flows_out"
writes:
  - "diagrams[kind=context]"
output_schema: none
language: en
stub: false
---
# Context

> The renderer is deterministic code: `src/modules/diagram/renderers/context.renderer.ts` (geometry in `context-layout.ts`). This skill documents the output and is loaded with `action/plantuml-conventions` only by the `render_fix` call.

- Step: S-2.5 System Context Diagram (re-rendered at S-3.6) · Section: `fixed:1` · Output: `svg` (built with `Scene`, geometry-checked, rasterised to PNG; no PlantUML)

## Output

- Level-0 data-flow diagram (context diagram) in Yourdon/DeMarco notation, drawn as SVG. ONE process only: the whole system is a circle in the centre, labelled `project.system_name ?? project.name` (a noun, never numbered, never a verb phrase). External entities are rectangles, ONE box per actor, labelled with the role name (singular noun; a person's name is never used). No data stores, no sub-processes, no flows between external entities, no dashed (control) flows.
- Fill `#7ACFF5` for the circle and every box, black strokes (1.2) and text, white page. No title on the picture — the document writes the figure caption.
- Every `flows_in` item (actor → system) and every `flows_out` item (system → actor) is its OWN straight arrow with a solid classic arrowhead and exactly ONE label, written along the arrow on a white background. No limit and no merging: 12 items ⇒ 12 arrows. An actor may be one-way: draw only the arrows that exist; never pair lists by index and never invent a counterpart (`Response to …`, `Acknowledgement of …`). The diagram as a whole always has at least one inbound AND one outbound arrow.
- Labels are data noun phrases in Title Case (`Login Credentials`, `Payment Result`), never verbs or use-case names (`login`, `pay`). English labels are Title Cased by the renderer (acronyms such as `SRS`, `OTP` and minor words `and/or/of/to/for/the/a/an/in/on/via` are kept); Vietnamese labels are drawn as written.
- Missing Spine data only (the content skills require real flows): an actor with no flows gets ONE fallback arrow by kind — `human` in `User Input`, `time` in `Scheduled Trigger`, `system` out `Service Request`. If the whole diagram is still one-way, the first actor by kind (human → system → time for a missing outbound, system → human → time for a missing inbound) gets `Processing Result` / `Service Request` / `Job Status` out, or `User Input` / `Service Response` / `Scheduled Trigger` in. Never label with use case names (they are actions, not data).
- Layout: people (`human`) on the left half, external systems and the scheduler (`system`, `time`) on the right half; one role only ⇒ the list is split in two for balance. Boxes sit on an ellipse around the circle; the flows of one actor run parallel to the actor–centre axis a fixed gap apart, so they never cross. The ring grows until every label fits on its own segment and nothing overlaps; the geometry check (`checkScene`: no text over text or shape, no line through a shape, no overlapping lines) is the gate — a remaining issue means no picture is stored.
- Elements are sorted by id, so the same Spine always yields the same picture.

## When it re-renders

The `source_hash` covers `project.system_name ?? project.name`, `actors[].name/.kind/.flows_in/.flows_out` and `use_cases[].name/.actor_ids` (use cases no longer appear on the diagram; they only cause a harmless extra re-render). Editing any description does not re-render. S-3.1 adds human actors, so the diagram drawn at S-2.5 goes stale and S-3.6 re-renders it.
