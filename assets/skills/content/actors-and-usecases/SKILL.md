---
skill_id: actors-and-usecases
kind: content
version: 0.1.0
description: "S-3.1–S-3.5 actors, roles, actor–goal list, missing use case sweep, relationships, descriptions"
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 6144
temperature: 0.3
reads:
  - "actors[]"
  - "roles[]"
  - "use_cases[]"
  - "functions[].id"
  - "addendum[]"
writes:
  - "actors[]"
  - "roles[]"
  - "use_cases[]"
output_schema: opTransaction
language: en
stub: true
---
# Actors And Usecases

> **STUB** — frontmatter is the contract; content is written in **T14**. Do not call this skill from production flows until `stub` is removed.

- Steps: S-3.1 Actors · S-3.2 Actor–Goal List · S-3.3 Missing Use Case Sweep · S-3.4 Use Case Relationships · S-3.5 Use Case Descriptions
- Section: fixed:2.1, fixed:2.2.2
- Output: `opTransaction`
