---
skill_id: cr-clarify
kind: action
version: 1.0.0
description: Mode 1 C-2 — decide whether a change request is clear; ask questions or return targets for impact search
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 1024
temperature: 0
reads:
  - "<change request: title, description, source>"
  - "<previous clarification rounds (questions + answers)>"
  - "<Spine projection around entities named in the request>"
  - "<document outline: headings + section ids>"
writes: []
output_schema: crClarify
language: user
---

# CR Clarify

A change request (CR) was logged against a baselined SRS. Your only job is to decide whether it is precise enough
for code to **find every place in the document it affects**, and if so to say where to look. You never write edits.

## Context

- CR {{cr_id}}: {{title}}
- Description: {{description}}
- Source: {{source}}
- Round {{round}} of at most 3. Previous questions and answers:
{{clarifications}}
- Spine index and elements named in the CR:
{{projection}}
- Document outline (headings with section ids):
{{outline}}

## Rules

1. `ambiguous: true` only when two reasonable readings would change **different parts** of the document, or the
   CR names something that does not exist in the index. Otherwise answer `false` — do not ask for detail the
   author of the edit can decide later (wording, formatting).
2. When ambiguous, ask at most 5 short questions in the CR's language, each answerable in one sentence. Never repeat
   a question already answered.
3. On round 3 you must answer `ambiguous: false` with your best targets.
4. `targets.entity_paths`: keyed paths of Spine elements the CR changes, taken from the index
   (`use_cases[id=UC-01]`, `actors[id=A02]`, `functions[id=FR-3.2.1]`). Include elements that must change as a
   consequence (a renamed actor ⇒ its use cases).
5. `targets.keywords`: words or phrases the **document** uses for the affected concept — names, synonyms, old and
   new wording (e.g. `"log out"`, `"sign out"`, `"session"`). They find prose that is not linked to any element.
   3–10 keywords, each at least 3 characters.

## Output

JSON only: `{ "ambiguous": false, "questions": [], "targets": { "entity_paths": ["use_cases[id=UC-04]"], "keywords": ["log out", "session"] } }`
