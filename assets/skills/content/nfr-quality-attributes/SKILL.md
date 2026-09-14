---
skill_id: nfr-quality-attributes
kind: content
version: 0.1.0
description: "S-6 NFRs — interfaces, usability, reliability and performance with numbers, domain attributes"
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 6144
temperature: 0.3
reads:
  - "project.type"
  - "project.domain"
  - "project.complexity"
  - "project.stakes"
  - "nfrs[]"
  - "actors[kind≠human]"
  - "addendum[]"
writes:
  - "nfrs[]"
output_schema: opTransaction
language: en
stub: true
---
# Nfr Quality Attributes

> **STUB** — frontmatter is the contract; content is written in **T18**. Do not call this skill from production flows until `stub` is removed.

- Steps: S-6.1 External Interfaces · S-6.2 Usability · S-6.3 Reliability · S-6.4 Performance · S-6.5 Domain-Specific Attributes
- Section: fixed:4.1, fixed:4.2.1, fixed:4.2.2, fixed:4.2.3, fixed:4.2.4
- Output: `opTransaction`
