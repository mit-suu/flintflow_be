---
skill_id: screen-flow
kind: renderer
version: 2.0.0
description: "S-4.2 Screens Flow (Graphviz DOT; one diagram per human actor using the UI, started by a diamond with the actor name)"
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 4096
temperature: 0.1
reads:
  - "screens[].name"
  - "screens[].flow_to"
  - "screens[].is_popup"
  - "screens[].tabs"
  - "actors[kind=human].name"
  - "roles[].actor_id"
  - "permissions[].screen_id"
  - "use_cases[].actor_ids"
  - "use_cases[].function_ids"
  - "functions[].screen_id"
writes:
  - "diagrams[kind=screen_flow]"
output_schema: puml
language: en
stub: false
---
# Screen Flow

> The renderer is deterministic code: `src/modules/diagram/renderers/screen-flow.renderer.ts`. This skill documents the output and is loaded with `action/plantuml-conventions` only by the `render_fix` call.

- Step: S-4.2 Screens Flow · Section: `fixed:3.1.1` · Output: `puml` (one or more parts)

## Split by actor

The Screens Flow is drawn **once per human actor that interacts directly with the system UI**
(`actors[kind=human]`). `system` and `time` actors (payment gateway, LLM provider, scheduler…) never get a
screens flow — they do not click through screens.

A screen belongs to an actor when either link exists (`src/modules/spine/screen-actors.ts`):

1. a `permissions[]` row on the screen whose `role_id` → `roles[].actor_id` is that actor, or
2. a use case with that actor in `actor_ids[]` lists a function whose `screen_id` is the screen.

One screen can belong to several actors (Login is shared) and then appears in each of their diagrams.

- Parts are ordered by actor id; each part carries the graph label `Screens flow for <actor name>`. The
  document uses that label as the image caption (`Screens flow for Founder`).
- A part holds only that actor's screens and only the `flow_to` edges between them.
- The part starts at a **diamond with the actor name inside** (`START`), with an arrow to every entry screen:
  not a pop-up and no incoming edge from a screen of the same part. If every screen has an incoming edge,
  the one with the lowest `queue_order`, then the lowest id.
- A screen linked to no human actor is an **orphan**: it is still drawn, in a last part labelled
  `Screens flow for unassigned screens` that starts at a black dot — and yellow flag `orphan_screen` points at it.
- No screen ↔ actor link at all yet (before S-4.3 / S-4.4): a single unlabelled diagram of every screen,
  black dot on the lowest `queue_order`.

## Per-part output (Graphviz DOT inside PlantUML)

A PlantUML state diagram cannot put text inside a diamond (`<<choice>>` is a fixed, unlabelled diamond), so
the Screens Flow is DOT wrapped in `@startdot … @enddot`:

```
@startdot
digraph screens_flow {
  graph [fontname="DejaVu Sans", fontsize=13, labelloc=t, compound=true, nodesep=0.4, ranksep=0.5];
  node [fontname="DejaVu Sans", fontsize=11, shape=box, style=rounded, color="#000000"];
  edge [arrowsize=0.8];
  label="Screens flow for Founder";
  START [label="Founder", shape=diamond, style=solid];
  S01 [label="Login"];
  S03 [label="Forgot Password\n(pop-up)", style="rounded,dashed"];
  subgraph cluster_S07 {
    label="Project Workspace"; style=rounded;
    S07_T1 [label="Chat"];
  }
  START -> S01;
  S01 -> S03;
  S05 -> S07_T1 [lhead=cluster_S07];
}
@enddot
```

- Screen = rounded box, **not filled** (PlantUML drops the border of a node that is both `rounded` and `filled`).
- A screen with `tabs[]` = `subgraph cluster_<id>`, one node `<id>_T<n>` per tab; edges into / out of it attach
  to `<id>_T1` with `lhead=` / `ltail=cluster_<id>`.
- `is_popup = true` → dashed border and a second line `(pop-up)`.
- Font `DejaVu Sans` on graph and node: the default Graphviz font is missing in the PlantUML image and dot
  answers with a fontconfig error instead of a picture.
- Labels are double-quoted, `"` becomes `'`, `\` is escaped. `<id> -> <target>` per kept edge, sorted by target id.
- **One-way arrows only.** When two screens point at each other, only the forward edge is drawn: from the
  screen closer to the part's entry (BFS depth) to the farther one; same depth → lower `queue_order`, then
  lower id. Return navigation is implicit and never drawn.
- A Spine without screens yields a single `NO_SCREENS` node, so the file still compiles.
- A broken DOT comes back from PlantUML as HTTP 200 with plain text `Error: <stdin>: syntax error…` (no SVG);
  compile-check treats any non-SVG body as an error.

## Orphan screens (`orphan_screen` yellow; `orphan_screen_at_baseline` red at S-9; remediation S-4.2)

A screen is flagged when, once links exist, no human actor uses it; or, once any `flow_to` edge exists, it
has neither an incoming nor an outgoing edge, or it is a pop-up nothing opens. Fix the data (connect the
screen, grant the actor a permission, wire the use case) — never hide the screen from the diagram.
