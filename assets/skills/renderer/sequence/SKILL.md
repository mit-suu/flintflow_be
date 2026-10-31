---
skill_id: sequence
kind: renderer
version: 1.0.0
description: "S-5.4 System Sequence Diagram, actor-system messages of a function (UML 2.5, black box, PlantUML source built in code: one diagram per function that needs one, in the function section of §3.x.y)"
provider: anthropic
aiModel: claude-haiku-5-5
maxTokens: 4096
temperature: 0.1
reads:
  - "functions[].name"
  - "functions[].screen_id"
  - "functions[].interactions"
  - "actors[].name"
  - "actors[].kind"
writes:
  - "diagrams[kind=sequence]"
output_schema: none
language: en
stub: false
---
# Sequence

> The renderer is deterministic code: `src/modules/diagram/renderers/sequence.renderer.ts` (data → `.puml`). The path is `puml` (PlantUML server, compile-check; `render_fix` may repair syntax only). This skill documents the output.

- Step: S-5.4 · Section: `function:<id>` (§3.x.y, after the function details) · `owner_kind = function`, `owner_id` = function id · Output: `puml`
- IEEE 830 Annex A.4 (stimulus / response sequence), optional. This is the **system** level (black box): actor ↔ `:System`. The design-level sequence (Controller → Service → Repository) of Report 4 is a different artifact and never drawn here.
- Which functions get a diagram (deterministic, from data): at least 2 `interactions` AND (a non-human actor takes part, OR some message is `abnormal` or has a `guard`, OR the function has no screen). A plain two-arrow screen function has no diagram: its normal / abnormal flows already say everything.

## Data → diagram

- Lifelines: human actors (stick figure, left), `:System` (box), external system / time actors (box, right; the actor that sends the first message stays left of `:System`). Names are the exact Spine actor names written `:Name`; only actors that send or receive a message appear. No Frontend, Backend, Validator or Repository lifeline.
- Message = one `interactions[]` element, in array order. `request` from an actor with a response coming back to the sender later ⇒ synchronous: solid line, filled arrowhead (`->`), the receiver gets an activation bar until it sends the response. A request with no response back ⇒ asynchronous: open arrowhead (`->>`). `response` ⇒ dashed line, open arrowhead (`-->>`).
- Numbering in the label: a request from an actor (the stimulus) is `1:`, `2:`…; every message after it until the next stimulus (responses included) is `1.1:`, `1.2:`… continuous across fragments.
- `abnormal` messages (each with a `guard`) form an `alt`: consecutive ones with the same guard are one operand, a different guard is the next `else`; the normal flow that follows is the last operand `else`. A `normal` message with a `guard` ⇒ `opt` (consecutive ones with the same guard share it). The Spine has no loop data yet, so no `loop` is drawn.
- Activation bars of the receiver of a request that opened before an `alt` stay through every operand and close after the frame (PlantUML cannot reopen a bar in the next operand).

## Rules

- Colours: fill `#7ACFF5`, black border and text, Arial, no shadow — the theme is written into the source (no `!include`). Labels are English; the localized document redraws from the translated Spine (`:Hệ thống`, `ngược lại`).
- Caption: `System Sequence Diagram — <function name>` and one description paragraph under the figure. Samples: `docs/diagram_guideline/sequence/`, `docs/diagram_image_test/sequence/`.
