---
skill_id: glossary
kind: content
version: 0.1.0
description: "S-8.1 Glossary — scan Spine for terms and abbreviations, user confirms (glossary_scan)"
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 6144
temperature: 0.3
reads:
  - "actors[].name"
  - "entities[].name"
  - "screens[].name"
  - "features[].name"
  - "glossary[]"
writes:
  - "glossary[]"
output_schema: opTransaction
language: en
stub: true
---
# Glossary

> **STUB** — frontmatter is the contract; content is written in **T18**. Do not call this skill from production flows until `stub` is removed.

- Steps: S-8.1 Glossary
- Section: fixed:5.5 (derived)
- Output: `opTransaction`
