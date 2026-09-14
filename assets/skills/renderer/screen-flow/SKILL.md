---
skill_id: screen-flow
kind: renderer
version: 1.0.0
description: "S-4.2 Screens Flow (state; composite for tabs, note for pop-ups)"
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 4096
temperature: 0.1
reads:
  - "screens[].name"
  - "screens[].flow_to"
  - "screens[].is_popup"
  - "screens[].tabs"
writes:
  - "diagrams[kind=screen_flow]"
output_schema: puml
language: en
stub: true
---
# Screen Flow

> The renderer is deterministic code: `src/modules/diagram/renderers/screen-flow.renderer.ts`. This skill documents the output and is loaded with `action/plantuml-conventions` only by the `render_fix` call. `stub: true` stays until the T03 asset test stops requiring it (XREQ T10→T03).

- Step: S-4.2 Screens Flow · Section: `fixed:3.1.1` · Output: `puml`

## Output

- `hide empty description`.
- `[*] --> <first screen>`: the first screen is the one with the lowest `queue_order`, then the lowest id.
- `state "<name>" as <id>` per screen.
- A screen with `tabs[]` becomes a composite state, with one sub-state per tab: `state "<tab>" as <id>_T<n>`.
- `is_popup = true` → `note right of <id> : pop-up`.
- `<id> --> <target>` for each `flow_to[]` entry that points to an existing screen, sorted by target id.
- A Spine without screens yields a single placeholder state, so the file still compiles.
