---
skill_id: context
kind: renderer
version: 0.1.0
description: "S-2.5 System Context Diagram (component / rectangle)"
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 4096
temperature: 0.1
reads:
  - "project.name"
  - "actors[kind≠human].name"
writes:
  - "diagrams[kind=context]"
output_schema: puml
language: en
stub: true
---
# Context

> **STUB** — frontmatter is the contract; content is written in **T10**. Do not call this skill from production flows until `stub` is removed.

- Steps: S-2.5 System Context Diagram
- Section: fixed:1
- Output: `puml`

Shared rules: `action/plantuml-conventions` (loaded together with this skill).
