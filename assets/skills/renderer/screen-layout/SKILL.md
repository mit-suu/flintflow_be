---
skill_id: screen-layout
kind: renderer
version: 0.1.0
description: "S-5.3 Screen Layout (salt, core screens only)"
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 4096
temperature: 0.1
reads:
  - "screens[id=<owner>].name"
  - "functions[screen_id=<owner>].name"
  - "functions[screen_id=<owner>].description"
writes:
  - "diagrams[kind=screen_layout]"
output_schema: puml
language: en
stub: true
---
# Screen Layout

> **STUB** — frontmatter is the contract; content is written in **T10**. Do not call this skill from production flows until `stub` is removed.

- Steps: S-5.3 Screen Layout
- Section: function:<primary_function_id>
- Output: `puml`

Shared rules: `action/plantuml-conventions` (loaded together with this skill).
