---
skill_id: product-overview
kind: content
version: 0.1.0
description: "S-2.1–S-2.3 Product Overview, Release 1.0 scope, external systems"
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 6144
temperature: 0.3
reads:
  - "project.name"
  - "project.vision"
  - "project.goals[]"
  - "addendum[]"
writes:
  - "project.vision"
  - "project.goals[]"
  - "project.release_scope"
  - "actors[kind≠human]"
output_schema: opTransaction
language: en
stub: true
---
# Product Overview

> **STUB** — frontmatter is the contract; content is written in **T14**. Do not call this skill from production flows until `stub` is removed.

- Steps: S-2.1 Product Overview · S-2.2 Release 1.0 Scope · S-2.3 External Systems
- Section: fixed:1
- Output: `opTransaction`
