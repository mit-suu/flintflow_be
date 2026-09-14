---
skill_id: high-level-rules
kind: content
version: 0.1.0
description: "S-2.4 High-Level Business Rules (tier=high)"
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 6144
temperature: 0.3
reads:
  - "project.vision"
  - "project.release_scope"
  - "addendum[]"
writes:
  - "business_rules[tier=high]"
output_schema: opTransaction
language: en
stub: true
---
# High Level Rules

> **STUB** — frontmatter is the contract; content is written in **T14**. Do not call this skill from production flows until `stub` is removed.

- Steps: S-2.4 High-Level Business Rules
- Section: fixed:1
- Output: `opTransaction`
