---
skill_id: screen-flow
kind: renderer
version: 4.0.0
description: "S-4.2 Screens Flow (notation of the FPT SRS template §3.1.1 sample, SVG built in code: one diagram for the whole system)"
provider: anthropic
aiModel: claude-haiku-5-5
maxTokens: 4096
temperature: 0.1
reads:
  - "screens[].name"
  - "screens[].flow_to[].to"
  - "screens[].is_popup"
  - "screens[].tabs"
  - "screens[].feature_id"
  - "screens[].primary_function_id"
  - "screens[].queue_order"
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

> The renderer is deterministic code: `src/modules/diagram/renderers/screen-flow.renderer.ts` (screens drawn, shared screens, split) and `screen-flow-layout.ts` (graph plan, geometry; algorithm in `docs/technical/screen-flow-diagram-layout.md`). Engine `svg`: no PlantUML source, no `render_fix`. This skill documents the output.

- Step: S-4.2 Screens Flow · Section: `fixed:3.1.1` · Output: `svg` (one part for the whole system)
- Source of the notation: FPT SRS template (Report3) §3.1.1 — "draw the Screens Flow for the system… oval notation for pop-up screen… screen with multiple information tab… text or background format for different visuality purpose".

## Notation (exactly the template sample, FlintFlow colours)

- **Screen**: rectangle with square corners, black border, screen name centred (wrapped, at most 4 lines).
- **Pop-up** (`is_popup`): oval, name inside (at most 3 lines).
- **Screen with tabs** (`tabs[]`): a frame with the screen name at the top and one small box per tab inside, tab names in *italic*. A pop-up with tabs is the same frame with rounded corners.
- **Navigation** (`flow_to[].to`): solid line, horizontal / vertical segments only, square corners, **small filled triangle** arrowhead at the target.
- **Fill**: `#7ACFF5` (in place of the template's yellow) for a **shared screen**, white for every other screen. Text black, `Liberation Sans` 13 like every FlintFlow SVG diagram.
- Nothing else: no swimlanes, no edge labels (`trigger` / `guard` stay in the Spine, not drawn), no decision diamonds, no start / end nodes, no title drawn in the picture. The document caption is the SVG `<title>` (`Screens flow`, `Screens flow (i/n)` when split); a legend paragraph under the figure explains the shapes and the blue fill.

## Layout

- Left to right. Column = rank (longest path from an entry screen), so every arrow points right.
- Each screen has one tree parent (forward edge from the previous column, lowest `queue_order`); rows follow the tree depth-first: a parent sits on the row of its first child (one straight arrow between them, like Home Page → User Login in the template), a leaf opens a new row.
- A screen with several targets in the next column uses **one shared trunk**: one stub out of the screen, one vertical line in the gutter, one horizontal branch with an arrowhead per target.
- An arrow skipping columns leaves into the gutter after its screen, runs along the street between two rows, and enters through the gutter before its target.
- Gutters (between columns) and streets (between rows) never contain a shape; every vertical segment has its own x, every horizontal segment its own y, ports on a screen side have their own y ⇒ no line crosses a shape or text and no two lines overlap; crossings only at right angles.

## One diagram for the system

- Every screen goes into one diagram, ordered by `queue_order`, then id.
- Over **40 screens**, or failing the layout check (`checkScene`): split by whole features (`features[].order`; a screen whose feature does not exist goes to a last group), packed greedily up to 40 screens per diagram; a feature that still does not fit is halved by rank in the flow. Each part is its own `diagrams[]` entry, `section = fixed:3.1.1`, `owner_kind = owner_id = null`; the first part keeps the original id. An arrow to a screen in another part is not drawn.

## Shared screens (blue fill)

`src/modules/spine/screen-actors.ts`. Actors of a screen, first source that yields a human actor wins:

1. screen → `primary_function_id` → function → use cases listing that function → `actor_ids`;
2. screen → every function with `screen_id` = the screen (no primary function, or it is in no use case);
3. `permissions[].screen_id` → `roles[].actor_id`.

A screen is **shared** when every leaf human actor (no human child) can use it: the leaf itself or one of its ancestors (`parent_id`) is among the screen's actors. With a single human actor every linked screen is shared. No screen ↔ actor link anywhere yet ⇒ every screen white.

## Entries, one-way edges

- Entry = representative of each strongly connected group with no edge coming from outside it (not a pop-up when another member exists, lowest `queue_order`). Login ⇄ Register therefore gives one entry.
- Edges go forward only: DFS from the entries drops the edge that closes a cycle, so of a pair pointing at each other only the edge away from the entry stays; return navigation is implicit.
- A diagram with no screens yields no part.

## Orphan screens (`orphan_screen` yellow; `orphan_screen_at_baseline` red at S-9; remediation S-4.2)

Every screen is drawn. Once screen ↔ actor links exist, a screen used by no human actor is flagged; once any `flow_to` edge exists, a screen with neither an incoming nor an outgoing edge, or a pop-up nothing opens, is flagged. Fix the data (connect the screen, wire the use case to its function) — never hide the screen from the diagram.
