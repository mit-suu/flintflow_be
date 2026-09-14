---
skill_id: screen-flow
kind: renderer
version: 0.1.0
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

> **STUB** — frontmatter is the contract; content is written in **T10**. Do not call this skill from production flows until `stub` is removed.

- Steps: S-4.2 Screens Flow
- Section: fixed:3.1.1
- Output: `puml`

Shared rules: `action/plantuml-conventions` (loaded together with this skill).
