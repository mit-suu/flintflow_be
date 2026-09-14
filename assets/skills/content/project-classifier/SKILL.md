---
skill_id: project-classifier
kind: content
version: 0.1.0
description: "S-1 Analyze & Validate Brief — extraction, project type/domain/complexity, conflicts, gap list"
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
  - "project.type"
  - "project.domain"
  - "project.complexity"
  - "assumptions[]"
output_schema: opTransaction
language: en
stub: true
---
# Project Classifier

> **STUB** — frontmatter is the contract; content is written in **T14**. Do not call this skill from production flows until `stub` is removed.

- Steps: S-1.1 Brief Extraction · S-1.2 Project Classification · S-1.3 Conflict & Assumption Review · S-1.4 Gap List
- Section: — (no SRS section)
- Output: `opTransaction`
