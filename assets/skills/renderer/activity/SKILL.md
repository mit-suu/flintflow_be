---
skill_id: activity
kind: renderer
version: 1.0.0
description: "S-3.5 Activity Diagram, processing flow of a use case (UML 2.5, swimlanes, SVG built in code: one diagram per use case that has activity nodes, in the Functions part - the feature section of the use case)"
provider: anthropic
aiModel: claude-haiku-5-5
maxTokens: 4096
temperature: 0.1
reads:
  - "use_cases[].name"
  - "use_cases[].activity_nodes"
  - "use_cases[].activity_flows"
  - "use_cases[].function_ids"
  - "functions[].feature_id"
  - "actors[].name"
writes:
  - "diagrams[kind=activity]"
output_schema: none
language: en
stub: false
---
# Activity

> The renderer is deterministic code: `src/modules/diagram/renderers/activity.renderer.ts` (lanes, inherited lanes) and `activity-layout.ts` (graph plan, geometry). It reuses the swimlane layout of the old activity-style screen flow (FLF-340, replaced by the FPT notation in FLF-349). Engine `svg`: no PlantUML source, no `render_fix`. This skill documents the output.

- Step: S-3.5 · `owner_kind = use_case`, `owner_id` = use case id · Output: `svg`
- Section: the **Functions** part - `feature:<id>` of the feature that holds the use case (feature of its first function, `featureOfUseCase`), printed after the feature content, one figure per use case by id; a use case with no feature yet ⇒ `fixed:2.2.2` (Use Case Descriptions).
- ISO/IEC/IEEE 29148 functional requirements: the processing flow of one use case. It answers "in which order is the work done, who does each step, where does it branch, loop or run in parallel". It is not the screen flow (§3.1.1) and not the System Sequence Diagram (messages between actor and system).
- **Not in the FlintFlow (FPT) template by default**: the data is written only when the user asks (chat / change request) or comes from an activity diagram image of an uploaded document (IEEE template: under each use case in Functions).
- **No data, no diagram**: a use case whose `activity_nodes[]` is empty has no diagram. Nothing is guessed from the use case or function text.

## Data → diagram

| Spine | UML 2.5 element | Drawn as |
| --- | --- | --- |
| `activity_nodes[kind=initial]` | Initial node | solid black dot |
| `activity_nodes[kind=final]` | Activity final | ring with a solid core (bullseye) |
| `activity_nodes[kind=action]` | Action | rounded rectangle, fill `#7ACFF5`, `name` inside (verb phrase, wrapped) |
| `activity_nodes[kind=decision]` | Decision node | diamond; with a `name` (the question, `Credentials valid?`) a flat hexagon that holds the text |
| `activity_nodes[kind=merge]` | Merge node | diamond, no text |
| `activity_nodes[kind=fork]` / `join` | Fork / join node | thick black bar |
| `activity_flows[]` | Control flow | solid line, **open arrowhead**, `[guard]` written on the line when `guard` is set |
| `activity_nodes[].lane` | Activity partition (swimlane) | vertical lane, header = exact actor name, `system` ⇒ `System` (`Hệ thống` in a Vietnamese document) |

- Lanes appear in the order their first node appears in `activity_nodes[]`. A node without a lane (initial, decision, merge, fork, join, final usually) sits in the lane of the node before it along the flow, else the node after it. No node has a lane ⇒ no lane frames.
- Lane actors follow the actor–use case model (`plantuml-conventions` rule 6): an actor of the use case, general actor kept, never a leaf actor, never a Frontend / Backend / Database lane.
- No title inside the picture; the document caption is the SVG `<title>` `Activity Diagram - <use case name>`, and a description paragraph under the figure gives the number of actions, decisions, parallel splits and the lanes.

## Layout

- Rows = longest path from the initial node along forward flows; every forward flow goes down. A flow back to an earlier node (a loop, e.g. "invalid ⇒ enter again") is drawn up a free gutter between columns and enters the target from the top.
- Lines are orthogonal: straight down when nothing is in between, a Z in the gap between two rows, or along a gutter. No line over a shape or text, no two overlapping lines, crossings only at right angles (`checkScene`, `allowBends: true`).
- A `[guard]` label has its own cell on the grid that only its own line goes through, so no other line can cross it.
- Not split: one use case is one flow. A layout that fails the check is reported as a layout error instead of drawing a wrong picture.

## Data rules (op validator `activityErrors`)

- Exactly one `initial`; ids unique in the whole Spine (`<use case id>-AN<n>`).
- Every `action` has a `name` (verb phrase: `Validate credentials`, not `Validation`).
- Flows join two nodes of the same use case; no self-flow (a loop goes through a decision); nothing flows into `initial`, nothing flows out of `final`.
- `decision` has ≥ 2 outgoing flows and every one has a `guard` (the condition without brackets); `fork` ≥ 2 outgoing, `join` ≥ 2 incoming.
- `lane` is an actor id or `system`; every node is reachable from `initial`.
