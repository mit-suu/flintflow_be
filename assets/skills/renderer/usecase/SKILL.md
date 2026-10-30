---
skill_id: usecase
kind: renderer
version: 3.0.0
description: "S-3.6 Use Case Diagram (UML 2.5.1, SVG built in code: one diagram per feature, include/extend, actor generalization diagram)"
provider: anthropic
aiModel: claude-haiku-5-5
maxTokens: 4096
temperature: 0.1
reads:
  - "project.system_name ?? project.name"
  - "actors[].name"
  - "actors[].kind"
  - "actors[].parent_id"
  - "use_cases[].name"
  - "use_cases[].actor_ids"
  - "use_cases[].function_ids"
  - "use_cases[].includes"
  - "use_cases[].extends"
  - "functions[].feature_id"
  - "features[].name"
  - "features[].order"
writes:
  - "diagrams[kind=usecase]"
output_schema: none
language: en
stub: false
---
# Usecase

> The renderer is deterministic code: `src/modules/diagram/renderers/usecase.renderer.ts` (grouping, order) and `usecase-layout.ts` (geometry, algorithm in `docs/technical/usecase-diagram-layout.md`). Engine `svg`: no PlantUML source, no `render_fix`. This skill documents the output.

- Step: S-3.6 Use Case Diagram · Section: `fixed:2.2.1` (actor hierarchy: `fixed:2.1`) · Output: `svg`

## Notation (UML 2.5.1)

- **System boundary**: one rectangle named `project.system_name ?? project.name`, fill `#7ACFF5`, holding every use case ellipse (all the same size, one column, same `cx`).
- **Actor**: stick figure, name below. `human` on the left, `system` / `time` on the right (stereotype `<<system>>` / `<<time>>` above the name), all OUTSIDE the boundary. An actor with child actors (`parent_id`) is **abstract** and its name is in *italic*.
- **Association** (actor – use case): solid line, NO arrowhead, ONE straight segment from the actor's hand to the left (human) or right (system/time) vertex of the ellipse. It never crosses another ellipse (same-size column ⇒ proven geometrically).
- `<<include>>`: dashed, **open arrowhead**, `base → included`. `<<extend>>`: dashed, open arrowhead, `extension → base`. Drawn as a vertical segment between two **adjacent** ellipses, label right of the line. Extension points and conditions are not drawn (they live in the use case table §2.2.2).
- **Generalization** between actors: solid line, hollow triangle at the general actor (own diagram, below). Use cases have no parent field in the Spine, so no use case generalization is drawn.
- No title drawn inside the picture: the document caption comes from the SVG `<title>` (`Use Cases — <feature>` / `Actor Hierarchy`).

## One diagram per feature

- Feature of a use case = `functions[].feature_id` of the first function in `function_ids` that still exists. Order: `features[].order`, then id.
- No feature derivable (before S-4.1, dead function id): the use case goes to a group named after its cluster's main human actor (first human in `actor_ids`; no human ⇒ smallest actor id), placed after all features.
- A group over 20 use cases is split into equal diagrams (`<name> (1/2)`, `(2/2)`…). A diagram that fails the layout check (`checkScene`) is split in half until it passes.
- Each part is its own `diagrams[]` entry with the same `kind`, `section = fixed:2.2.1`, `owner_kind = null`, `owner_id = null`. The first part keeps the original id (`<base>`, then `<base>-2`, …) so a signed baseline keeps its image.

## Actors as modelled

- A use case is linked to **every** actor in `actor_ids`; several human actors may share one use case on a diagram. A general actor stays general (`User`) — never expanded to leaf actors, never merged.
- A **human** actor is not connected to a use case that is the target of an `<<include>>` or the source of an `<<extend>>` drawn in the same diagram: it reaches it through the base. A human actor left with no edge keeps the edge to its smallest use case id. `system`/`time` actors keep every edge.
- Only actors with an edge in that diagram are drawn.

## Include / extend placement

- A relation is drawn only when both use cases are in the same diagram. A use case has two neighbours in a column, so the relation graph is cut into simple chains (`relationChains`): an extension of two bases sits between them; a use case with more than two relations, or a cycle, appears in several diagrams of the group — every relation exactly once, always between adjacent rows.
- Order inside a diagram: chains and single use cases sorted by main actor, then id.

## Actor hierarchy diagram

- Present only when at least one valid `parent_id` exists (human → human; edges with a `system`/`time` actor, self-reference or cycle are ignored and raise `actor_generalization_invalid`). One diagram, last in the list, `section = fixed:2.1`, rendered under the actors table.
- Every human actor, child below parent, each edge one straight segment with a hollow triangle at the parent. The general actor's description in §2.1 must name its children (flag `actor_generalization_children_unlisted`).
