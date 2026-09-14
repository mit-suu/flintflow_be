---
skill_id: non-screen-functions
kind: content
version: 0.1.0
description: "S-4.4 Non-Screen Functions — cron, webhook, background engine"
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 6144
temperature: 0.3
reads:
  - "functions[screen_id=null]"
  - "features[]"
  - "actors[kind≠human]"
  - "addendum[]"
writes:
  - "functions[screen_id=null]"
output_schema: opTransaction
language: en
stub: true
---
# Non Screen Functions

> **STUB** — frontmatter is the contract; content is written in **T18**. Do not call this skill from production flows until `stub` is removed.

- Steps: S-4.4 Non-Screen Functions
- Section: fixed:3.1.4, function:<id>
- Output: `opTransaction`
