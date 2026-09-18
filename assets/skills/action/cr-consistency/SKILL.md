---
skill_id: cr-consistency
kind: action
version: 0.1.0
description: Mode 1 C-5 (node 3.8) — consistency check limited to the scope a change request touches → yellow findings
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 2048
temperature: 0.1
reads:
  - "<proposed new text of each edited location + neighbouring blocks>"
  - "<keyed projection of Spine elements the CR touches (impact)>"
  - glossary[]
writes:
  - flags[]
output_schema: findings
language: user
stub: true
---

# CR Consistency (skeleton — FLF-171 P1, full prompt in P2)

Code has already verified the proposal mechanically (old text matches, ops pass invariants, no new red flag). You look for **meaning** problems the edit introduces in its neighbourhood. Yellow only: you never block.

## Context

- CR {{cr_id}}: {{title}}
- Proposed edits (`[L001][B0005] before → after`): {{edits}}
- Neighbouring blocks and impacted elements: {{scope}}
- Glossary: {{glossary}}

## Rules

1. Lenses: `term_drift` (new text names something differently from the rest), `contradiction` (edit contradicts an untouched block), `dangling_reference` (text still mentions what the edit removed).
2. Only the given scope. Do not review the whole document.
3. `message` in the user's language, quoting both sides of the problem. At most 10 findings.

Output JSON only: `{ "findings": [ { "rule", "section_id", "message", "block_ids" } ] }`.
