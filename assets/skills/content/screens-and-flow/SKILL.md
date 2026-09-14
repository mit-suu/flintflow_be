---
skill_id: screens-and-flow
kind: content
version: 0.1.0
description: "S-4.1–S-4.2 feature & screen inventory (fixes N and screen_queue), screens flow"
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 6144
temperature: 0.3
reads:
  - "features[]"
  - "screens[]"
  - "use_cases[]"
  - "roles[]"
  - "addendum[]"
writes:
  - "features[]"
  - "screens[]"
  - "functions[]"
  - "progress.screen_queue[]"
output_schema: opTransaction
language: en
stub: true
---
# Screens And Flow

> **STUB** — frontmatter is the contract; content is written in **T18**. Do not call this skill from production flows until `stub` is removed.

- Steps: S-4.1 Screen Inventory · S-4.2 Screens Flow
- Section: fixed:3.1.1, fixed:3.1.2, feature:<id>
- Output: `opTransaction`
