---
skill_id: entities-erd
kind: content
version: 0.1.0
description: "S-4.5 entities, descriptions and relations (feeds renderer/erd)"
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 6144
temperature: 0.3
reads:
  - "entities[]"
  - "functions[].name"
  - "screens[].name"
  - "addendum[]"
writes:
  - "entities[]"
output_schema: opTransaction
language: en
stub: true
---
# Entities Erd

> **STUB** — frontmatter is the contract; content is written in **T18**. Do not call this skill from production flows until `stub` is removed.

- Steps: S-4.5 Entity Relationship Diagram
- Section: fixed:3.1.5
- Output: `opTransaction`
