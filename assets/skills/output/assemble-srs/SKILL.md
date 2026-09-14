---
skill_id: assemble-srs
kind: output
version: 0.1.0
description: "S-8.2 Document Assembly + S-8.3 Record of Changes — deterministic, FPT order, section numbering"
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 1024
temperature: 0.1
reads:
  - "<whole Spine>"
  - "changes[]"
  - "diagrams[]"
  - "flags[]"
writes: []
output_schema: none
language: en
stub: true
---
# Assemble Srs

> **STUB** — frontmatter is the contract; content is written in **T15**. Do not call this skill from production flows until `stub` is removed.

- Steps: S-8.2 Document Assembly · S-8.3 Record of Changes
- Section: all + fixed:I
- Output: `none`
