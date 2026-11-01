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
- Nothing else: no swimlanes, no edge labels (`trigger` / `guard` stay in the Spine, not drawn), no decision diamonds, no start / end nodes, no title drawn in the picture. The document caption is the SVG `<title>` (`Screens flow`; when split `Screens flow (<actor>)`, `Screens flow (i/n)` or both); a legend paragraph under the figure explains the shapes and the blue fill.

## Layout

- Left to right, as a tree: each screen has one parent = the screen that reaches it first in a breadth-first walk from the entries (shallowest way in, then lowest `queue_order`); column = depth, so a child sits right after its parent. Rows follow the tree depth-first: a parent sits on the row of its first child (one straight arrow between them, like Home Page → User Login in the template), a leaf opens a new row.
- **Only the tree is drawn**: one arrow into each screen from its parent, plus every arrow into a pop-up; a root screen whose targets all have another parent keeps its first arrow, so it is not left alone. Other ways in stay in `flow_to` (traceability, descriptions) but are not drawn — cross links tangle the picture once there are many screens.
- Each screen has **one way out**: a lone straight arrow to the screen on its row in the next column, or **one shared trunk** (one stub, one vertical line in the gutter) with a horizontal branch per target in the next column.
- An arrow to a pop-up outside the next column leaves the trunk, runs along the street next to the target row and enters through the gutter before the pop-up; several such arrows into one pop-up from the same side merge into one collector with a single arrowhead.
- Gutters (between columns) and streets (between rows) never contain a shape; every vertical segment has its own x, every horizontal segment its own y, ports on a screen side have their own y ⇒ no line crosses a shape or text and no two lines overlap; crossings only at right angles.

## One diagram for the system

- Every screen goes into one diagram, ordered by `queue_order`, then id.
- Over **40 screens**, over **10 columns** (too small once fitted to an A4 page), or failing the layout check (`checkScene`): first one diagram per human actor with the screens that actor (or an actor it specialises) uses — shared screens appear in every one, like *Screens flow for User / for Admin*; an actor whose screens all sit in another diagram is dropped, screens with no actor go to `Other screens`. Skipped with fewer than two actors or when over 20% of the screens have no actor. A diagram that still does not fit is split by whole features (`features[].order`; a screen whose feature does not exist goes to a last group), packed greedily up to 40 screens per diagram; a feature that still does not fit is halved by rank in the flow. Each part is its own `diagrams[]` entry, `section = fixed:3.1.1`, `owner_kind = owner_id = null`; the first part keeps the original id. Each part also carries the screens on the path from an entry to its screens (whole-system tree; only the direct parent when the full path makes the part unreadable), so no screen loses its parent to another part — hub screens may appear in several parts.

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
