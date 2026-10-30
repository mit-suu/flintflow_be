---
skill_id: erd
kind: renderer
version: 2.0.0
description: "S-4.5 Entity Relationship Diagram (SVG built in code; Chen | Crow's foot | IDEF1X per project)"
provider: anthropic
aiModel: claude-haiku-5-5
maxTokens: 4096
temperature: 0.1
reads:
  - "entities[].name"
  - "entities[].relations"
  - "entities[].relation_verbs"
  - "entities[].relation_cardinality"
  - "entities[].relation_optional"
writes:
  - "diagrams[kind=erd]"
output_schema: none
language: en
stub: false
---
# Erd

> The renderer is deterministic code: `src/modules/diagram/renderers/erd.renderer.ts` (data, splitting) and `erd-layout.ts` (notation drawing) on the shared grid placer / orthogonal router (`orthogonal-place.ts`, `orthogonal-route.ts`). There is no `puml` source, so `render_fix` never applies. This skill documents the output.

- Step: S-4.5 Entity Relationship Diagram · Section: `fixed:3.1.5` · Output: `svg`
- The notation is a **project setting** (`Project.erdNotation`: `chen` | `crowsfoot` | `idef1x`, default `chen`), not in the Spine. One notation per document. Changing it changes the diagram hash ⇒ the diagram is redrawn (`PATCH /projects/:id/erd-notation` redraws an existing ERD at once).

## Data → diagram

- One box per entity (`name`, bold, wrapped to ≤ 2 lines). Entity name is a singular noun. Attributes are **not** in the Spine yet, so boxes have no attribute compartment (Chen: no ovals) until `entities[].attributes` exists; the drawing code for them is ready.
- One relation per `relations[]` id that points to an existing entity, parent → child, id `<parent>><child>`:
  - label = `relation_verbs[<child>]`, `has` when missing (never empty, never a flipped / passive verb — see `content/entities-erd`);
  - parent end = `1`, or `0..1` when the child is in the parent's `relation_optional` (the child may exist without this parent);
  - child end = `relation_cardinality[<child>]`: `N` many (default), `1` one. The minimum on the child side is not in the Spine, so it is drawn as 0.
- Self relations and several relations between two entities are drawn (each its own line / diamond).

## Notations

| | Entity | Relation | Parent end | Child end |
| --- | --- | --- | --- | --- |
| Chen | rectangle | diamond with the verb; entity — diamond — entity | label `1`; single line | label `N` / `1`; **double line** when the child must have a parent (not optional), single when optional |
| Crow's foot | rectangle, bold name | one line, verb on the line | `\|\|` one, `\|o` zero or one | crow's foot + ring `o{` zero or many, bar + ring `\|o` zero or one |
| IDEF1X | rectangle (independent) / rounded (dependent) | dashed line = non-identifying (solid = identifying, not in the Spine yet), verb on the line | hollow diamond when optional | solid dot; `Z` beside it for one-to-one |

All fills `#7ACFF5`, stroke / text black.

## Layout (shared by the three notations)

- Grid placement by parent → child rank; right-angle lines only (`allowBends`), straight when nothing is in the way, otherwise L / Z / U bends. No line through a shape or text, no overlapping lines (`checkScene` issues must be empty). Crossings are right-angle only.
- More than 25 entities ⇒ split: connected components are packed into diagrams of ≤ 25; a larger component is cut in breadth-first order (relations across a cut are not drawn). Title `Entity Relationship Diagram (i/n)`; the first part keeps the original diagram id.
- A diagram that fails the geometry check is split again; a single entity that cannot be routed yields `render_error`.
- A Spine without entities yields one placeholder box.
