---
skill_id: product-brief
kind: content
version: 0.1.0
description: "B-0 Intake, B-1 Product Brief, B-2 Brief Finalize — adapted from BMAD bmad-product-brief"
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 6144
temperature: 0.3
reads:
  - "project"
  - "addendum[]"
  - "assumptions[]"
  - "other_requirements[]"
writes:
  - "project"
  - "addendum[]"
  - "assumptions[]"
  - "other_requirements[]"
output_schema: discoveryStep
language: user
stub: true
---
# Product Brief

> **STUB** — frontmatter is the contract; content is written in **T20**. Do not call this skill from production flows until `stub` is removed.

- Steps: B-0.1…B-0.4 · B-1.1…B-1.6 · B-2.1 Assumption Sweep · B-2.2 Addendum Triage · B-2.3 Three-Lens Review
- Section: — (no SRS section; feeds §1, §2, §3, §4, §5.4 via Spine)
- Output: `discoveryStep`
