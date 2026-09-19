---
skill_id: cr-clarify
kind: action
version: 0.1.0
description: Mode 1 C-2 — decide whether a change request is clear; ask questions or return targets for impact search
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 1024
temperature: 0
reads:
  - "<change request: title, description, source>"
  - "<previous clarification rounds (questions + answers)>"
  - "<Spine projection around entities named in the request>"
  - "<document outline: headings + block ids>"
writes: []
output_schema: crClarify
language: user
stub: true
---

# CR Clarify (skeleton — FLF-171 P1, full prompt in P2)

A change request (CR) was logged against a baselined SRS. Decide if it is precise enough to locate every place it affects.

## Context

- CR {{cr_id}}: {{title}} — {{description}} (source: {{source}})
- Round {{round}} of at most 3. Previous rounds: {{clarifications}}
- Spine projection: {{projection}}
- Document outline: {{outline}}

## Rules

1. `ambiguous: true` only when two reasonable readings would change different parts of the document. Ask at most 5 short questions in the user's language, each answerable in one sentence.
2. `ambiguous: false` ⇒ return `targets`: `entity_paths` (keyed paths such as `use_cases[id=UC-2.4]`) and `keywords` the document uses. Code searches the document with them; include synonyms the document uses.
3. On round 3 you must answer `ambiguous: false` with your best targets.
4. Never propose edits here.

Output JSON only: `{ "ambiguous", "questions", "targets": { "entity_paths", "keywords" } }`.
