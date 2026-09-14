---
skill_id: appendix-content
kind: content
version: 0.1.0
description: "S-7 appendix — detail business rules, common requirements, messages, other requirements (mostly derived)"
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 6144
temperature: 0.3
reads:
  - "functions[].validations[]"
  - "functions[].abnormal[]"
  - "other_requirements[]"
  - "addendum[]"
writes:
  - "business_rules[tier=detail]"
  - "common_requirements[]"
  - "messages[]"
  - "other_requirements[]"
output_schema: opTransaction
language: en
stub: true
---
# Appendix Content

> **STUB** — frontmatter is the contract; content is written in **T18**. Do not call this skill from production flows until `stub` is removed.

- Steps: S-7.1 Business Rules · S-7.2 Common Requirements · S-7.3 Application Messages · S-7.4 Other Requirements
- Section: fixed:5.1, fixed:5.2, fixed:5.3, fixed:5.4
- Output: `opTransaction`
