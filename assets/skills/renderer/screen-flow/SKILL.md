---
skill_id: screen-flow
kind: renderer
version: 3.0.0
description: "S-4.2 Screens Flow (UML 2.5 Activity Diagram with swimlanes, SVG built in code: one diagram per feature, lane = actor of the screen's use case)"
provider: anthropic
aiModel: claude-haiku-5-5
maxTokens: 4096
temperature: 0.1
reads:
  - "screens[].name"
  - "screens[].flow_to"
  - "screens[].is_popup"
  - "screens[].tabs"
  - "screens[].feature_id"
  - "screens[].primary_function_id"
  - "screens[].queue_order"
  - "features[].name"
  - "features[].order"
  - "actors[kind=human].name"
  - "actors[].parent_id"
  - "roles[].actor_id"
  - "permissions[].screen_id"
  - "use_cases[].actor_ids"
  - "use_cases[].function_ids"
  - "functions[].screen_id"
writes:
  - "diagrams[kind=screen_flow]"
output_schema: none
language: en
stub: false
---
# Screen Flow

> The renderer is deterministic code: `src/modules/diagram/renderers/screen-flow.renderer.ts` (grouping, lanes, split) and `screen-flow-layout.ts` (graph plan, geometry; algorithm in `docs/technical/screen-flow-diagram-layout.md`). Engine `svg`: no PlantUML source, no `render_fix`. This skill documents the output.

- Step: S-4.2 Screens Flow · Section: `fixed:3.1.1` · Output: `svg` (one part per feature)

## Notation (UML 2.5 Activity Diagram, swimlanes)

- **Screen** = action: rounded rectangle, fill `#7ACFF5`, the screen name inside (wrapped to 3 lines). A **pop-up** is an action with the stereotype `<<pop-up>>` above the name; a screen with `tabs[]` has one more line `[tab | tab]` under the name (wrapped between tabs). No ovals, no diamonds.
- **Initial node**: solid black dot, one above each entry screen. **Activity final**: circle with a solid black dot, one below each ending screen (bottom row).
- **Control flow**: solid line, **open arrowhead**, one per `screens[].flow_to` pair inside the diagram. Straight when the two screens share a column with nothing between; otherwise orthogonal bends (a Z) in the gap between rows, or down a free gutter between columns when the target is more than one row below. Never through a shape or text, never overlapping another line; crossings only at right angles.
- **Swimlane** (ActivityPartition): vertical lane, container rectangle with a header cell holding the **exact actor name** (the name of a general actor does not list its children — that is defined in §2.1 and the actor hierarchy diagram).
- No title drawn in the picture: the document caption is the SVG `<title>` (`Screens flow — <feature>`); a paragraph under each figure says the lanes follow the actor model (see §2.1).
- No decision node, no guard, no trigger label yet: the Spine has no data for them.

## One diagram per feature

- Group = `screens[].feature_id`, ordered by `features[].order` then id; a screen whose feature does not exist goes to a last group `Other`. Screens inside a diagram are ordered by `queue_order`, then id.
- A group over 25 screens is split into equal diagrams by rank in the flow (`<feature> (1/2)`…); a diagram failing the layout check (`checkScene`) is split in half until it passes. Each part is its own `diagrams[]` entry, `section = fixed:3.1.1`, `owner_kind = owner_id = null`; the first part keeps the original id.
- A `flow_to` pointing to a screen of another feature is not drawn (the target is not in this diagram).

## Lanes = actors of the screen

`src/modules/spine/screen-actors.ts`, first source that yields a human actor wins:

1. screen → `primary_function_id` → function → use cases listing that function → `actor_ids`;
2. screen → every function with `screen_id` = the screen (no primary function, or it is in no use case);
3. `permissions[].screen_id` → `roles[].actor_id`.

- Several actors with a common ancestor (`parent_id`) ⇒ the lane of the nearest common ancestor (general actor kept, never expanded to leaf actors). No "public screen belongs to every actor" rule: a public screen sits in the lane of the actor its use case names (Guest on Login when the use case is Guest's).
- **Ambiguous** (several actors, no common ancestor): the screen goes to the first actor in `actor_ids` order and yellow flag `screen_actor_ambiguous` (S-3.1) asks the user to review the actor model (add a general actor, fix `actor_ids`).
- Lane order = first appearance when screens are read by rank then `queue_order`.
- No actor at all ⇒ the screen has no lane, it is **not drawn** and `orphan_screen` points at it. No screen ↔ actor link anywhere yet (before S-4.4) ⇒ every screen is drawn in one diagram per feature without lane frames.

## Entries, endings, one-way edges

- Entry = representative of each strongly connected group with no edge coming from outside it (not a pop-up when another member exists, lowest `queue_order`). Login ⇄ Register therefore gives one entry.
- Edges go forward only: DFS from the entries drops the edge that closes a cycle, so of a pair pointing at each other only the edge away from the entry stays; return navigation is implicit. Rank = longest path from an entry; every edge goes down.
- Ending screen = no forward edge out (inside this diagram). A diagram with no screens yields no part.

## Orphan screens (`orphan_screen` yellow; `orphan_screen_at_baseline` red at S-9; remediation S-4.2)

A screen is flagged when, once links exist, no human actor uses it; or, once any `flow_to` edge exists, it has neither an incoming nor an outgoing edge, or it is a pop-up nothing opens. Fix the data (connect the screen, wire the use case to its function) — never hide the screen from the diagram.
