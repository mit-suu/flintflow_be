---
skill_id: usecase
kind: renderer
version: 0.1.0
description: "S-3.6 Use Case Diagram (usecase, include/extend)"
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 4096
temperature: 0.1
reads:
  - "actors[].name"
  - "actors[].kind"
  - "use_cases[].name"
  - "use_cases[].actor_ids"
  - "use_cases[].includes"
  - "use_cases[].extends"
writes:
  - "diagrams[kind=usecase]"
output_schema: puml
language: en
stub: true
---
# Usecase

> **STUB** — frontmatter is the contract; content is written in **T10**. Do not call this skill from production flows until `stub` is removed.

- Steps: S-3.6 Use Case Diagram
- Section: fixed:2.2.1
- Output: `puml`

Shared rules: `action/plantuml-conventions` (loaded together with this skill).
