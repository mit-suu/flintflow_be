---
skill_id: erd
kind: renderer
version: 0.1.0
description: "S-4.5 Entity Relationship Diagram (entity + crow's foot)"
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 4096
temperature: 0.1
reads:
  - "entities[].name"
  - "entities[].relations"
writes:
  - "diagrams[kind=erd]"
output_schema: puml
language: en
stub: true
---
# Erd

> **STUB** — frontmatter is the contract; content is written in **T10**. Do not call this skill from production flows until `stub` is removed.

- Steps: S-4.5 Entity Relationship Diagram
- Section: fixed:3.1.5
- Output: `puml`

Shared rules: `action/plantuml-conventions` (loaded together with this skill).
