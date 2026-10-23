---
skill_id: usecase
kind: renderer
version: 2.0.0
description: "S-3.6 Use Case Diagram (one diagram per actor, include/extend, actor generalization)"
provider: anthropic
aiModel: claude-sonnet-5-5
maxTokens: 4096
temperature: 0.1
reads:
  - "actors[].name"
  - "actors[].kind"
  - "actors[].parent_id"
  - "use_cases[].name"
  - "use_cases[].actor_ids"
  - "use_cases[].includes"
  - "use_cases[].extends"
writes:
  - "diagrams[kind=usecase]"
output_schema: puml
language: en
stub: false
---
# Usecase

> The renderer is deterministic code: `src/modules/diagram/renderers/usecase.renderer.ts`. This skill documents the output and is loaded with `action/plantuml-conventions` only by the `render_fix` call.

- Step: S-3.6 Use Case Diagram · Section: `fixed:2.2.1` · Output: `puml`

## Output

- `actor "<name>" as <id>`; `kind = system` adds `<<system>>` and `kind = time` adds `<<time>>`.
- All use cases sit inside `rectangle "<project.name>" { usecase "<name>" as <id> }`.
- Association (no arrowhead). The edge direction sets the side under `left to right direction`: a `human` actor is written `actor -- use case` (left), a `system`/`time` actor `use case -- actor` (right). Human actors are declared before the `rectangle`, system/time actors after it.
- **One human actor per diagram.** In a diagram, every use case is associated with **at most one human actor** — the actor the diagram belongs to. Two human actors never share an association to the same use case in one diagram. `system`/`time` actors that take part are drawn as secondary actors on the right.
- A **human** actor is not connected to a use case that has `extends[]` or is included by another use case **when that base use case is in the same diagram** — it reaches it through the base. If the base belongs to another actor's diagram, the edge is kept so the use case does not float. A human actor whose every edge would be dropped keeps the edge to its smallest use case id. `system`/`time` actors keep every edge (the payment gateway in "Pay Deposit").
- Only actors that have an edge in that part are declared (plus a generalization parent, below).
- `base ..> included : <<include>>` for `includes[]`; `extension ..> base : <<extend>>` for `extends[]` — drawn only when both ends are in the part.

## One diagram per actor

- Each **human** actor gets its own part: every use case it takes part in, plus what those use cases `include` and the use cases that `extend` them (recursively). It never pulls in another role's base use case (Founder takes part in "Verify Document", which Business Analyst's "Sign Baseline" includes ⇒ the Founder diagram shows "Verify Document" connected to Founder, without "Sign Baseline").
- A use case shared by several human actors appears in **each** of their diagrams, connected only to that diagram's actor (Log In in the Lecturer, Student and Office diagrams; View Timetable in Lecturer and Student). This repetition is required, not duplication: each diagram is complete for its actor.
- Use cases no human actor reaches (a scheduler's job, an external system's callback) are grouped by relation cluster under the cluster's first actor and get their own parts (`Use Cases — Class End Scheduler`).

## Actor generalization (`actors[].parent_id`)

- `parent_id` marks a human actor as a specialized type of a general human actor (`Customer --|> User`). Only human ↔ human edges count: an edge with a `system`/`time` actor, a self-reference or a cycle is ignored (and raises `actor_generalization_invalid`).
- **Lifting**: human actors of one inheritance tree on the same use case are replaced by their nearest common general actor **only when that is true of every specialization**: the general actor is already listed (children beside it are redundant), or the listed actors cover every direct child of it (Log In for Lecturer, Student and Office when `User` has exactly those three). The use case is then drawn once, in the `User` diagram, and not repeated in the specialized diagrams — they inherit it. A use case shared by only **some** roles is not lifted; it is repeated in each of those roles' diagrams.
- Each specialized actor's diagram declares its parent (no association) and draws `parent <|-- child` (same relation as `child --|> parent`; parent written first so it sits leftmost). A specialized actor left with no use case of its own is drawn with its generalization in its parent's diagram, so it never disappears.
- The general actor has no Screens Flow diagram of its own: screens it reaches belong to every specialized actor below it (`screen-actors.ts`).

## Order and splitting

- Always one part per human actor (above), even when everything would fit in one diagram. Order: general actors (generalization parents) → specialized actors by depth → other human actors → non-human groups; ties by actor id.
- One diagram holds at most 20 use cases **and** at most 24 actor–use case edges. An actor's part over either limit is split by relation cluster (connected component of the include/extend graph inside that part), so an include/extend edge never crosses a boundary unless a cluster alone is longer than 40 (then chunked by 20 and the crossing edge dropped).
- Each part is its own `diagrams[]` entry with the same `kind`. The first part keeps the unsuffixed id (`<base>`, then `<base>-2`, `<base>-3`, …) so a signed baseline referencing `<base>` keeps its image.
- Title is `Use Cases — <actor name>`; a project with a single part has no title.
