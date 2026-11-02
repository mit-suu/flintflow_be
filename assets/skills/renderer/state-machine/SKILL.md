---
skill_id: state-machine
kind: renderer
version: 1.0.0
description: "S-4.5 State Machine Diagram, entity lifecycle (UML 2.5, SVG built in code: one diagram per entity that has states, next to the entity description in §3.1.5)"
provider: anthropic
aiModel: claude-haiku-5-5
maxTokens: 4096
temperature: 0.1
reads:
  - "entities[].name"
  - "entities[].states"
  - "entities[].transitions"
writes:
  - "diagrams[kind=state_machine]"
output_schema: none
language: en
stub: false
---
# State Machine

> The renderer is deterministic code: `src/modules/diagram/renderers/state-machine.renderer.ts` (data, label text) and `state-machine-layout.ts` (shapes, layout, label placement). There is no `puml` source, so `render_fix` never applies. This skill documents the output.

- Step: S-4.5 · Section: `fixed:3.1.5` (after the entity table, with a description paragraph) · `owner_kind = entity`, `owner_id` = entity id · Output: `svg`
- IEEE 830 Annex A.1 (organised by mode), optional. Only entities with a real lifecycle (order, change request, invitation, baseline…) have `states[]`; an entity with no states has no diagram — nothing is invented, no placeholder.
- Every state is a `states[]` element, every transition a `transitions[]` element. A diagram is never split.

## Data → diagram

- State = rounded rectangle (`#7ACFF5`, black border), bold name inside (≤ 2 lines). The name is an adjective or participle (Pending, Approved), never an action.
- Initial = solid black dot with an open arrow to the state whose `initial` is true (exactly one). Final = bullseye (ring with a solid core), one for each state whose `final` is true, with an open arrow from that state; a final state has no outgoing transition.
- Transition (`from` ≠ `to`) = ONE straight solid line from state `from` to state `to`, open (V) arrowhead at `to`, label `event [guard] / action`. `guard` and `action` are left out together with their `[ ]` / `/` when empty. The label is horizontal (several lines when long) or, on a steep line crowded by parallel lines, one line along the line.
- Several transitions between the same two states (A → B and B → A, or two events A → B) are parallel segments, never one on top of another.
- Self-transition (`from = to`) is an UML internal transition: written as `event [guard] / action` in a lower compartment of the state, separated by a divider. No loop line is drawn.
- `business_rule_ids` are not drawn (they trace the transition to its rule in the Spine).

## Layout

- No bends: `allowBends = false`. Every line is a straight segment; `checkScene` issues must be empty (no line over a shape or text, no overlapping lines, no text over text).
- States by BFS layer from the initial state, in a row-per-layer or column-per-layer arrangement; several arrangements (gaps, order inside a layer, a circle) are tried, then states are swapped to cut crossings. The best arrangement is the one with no `checkScene` issue, the fewest crossing lines, then the lowest cost (length, aspect ratio). No arrangement valid ⇒ `render_status = error`.
- A state grows when several lines leave one side, so parallel lines meet the straight part of its edge.
- Title (`<title>` of the SVG, figure caption): `State Machine Diagram — <entity>`. Samples: `docs/diagram_guideline/state-machine/`, `docs/diagram_image_test/state-machine/`.
