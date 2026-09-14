---
skill_id: authorization-matrix
kind: content
version: 0.1.0
description: "S-4.3 Screen Authorization — screen × role matrix with per-action rows"
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 6144
temperature: 0.3
reads:
  - "roles[]"
  - "actors[]"
  - "screens[].name"
  - "screens[].feature_id"
  - "permissions[]"
writes:
  - "permissions[]"
  - "roles[]"
output_schema: opTransaction
language: en
stub: true
---
# Authorization Matrix

> **STUB** — frontmatter is the contract; content is written in **T18**. Do not call this skill from production flows until `stub` is removed.

- Steps: S-4.3 Screen Authorization
- Section: fixed:3.1.3
- Output: `opTransaction`
