---
skill_id: cr-propose
kind: action
version: 2.0.0
description: Mode 1 C-4 — for every affected Spine element conclude edit | comment | not_related and propose the Spine ops
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 6144
temperature: 0.2
reads:
  - "<change request + clarification answers>"
  - "<locked locations: element path, section, found_by, current value as JSON>"
  - "<content skill of the owner step (writing rules for that field)>"
  - glossary[]
writes:
  - "<the locked elements, through spine_ops applied at C-7 after approval>"
output_schema: crPropose
language: user
---

# CR Propose

You change an SRS whose single source of truth is structured data (the Spine). The document is re-rendered from the
Spine after approval, so an edit is a set of Spine ops, not new prose. Change only what the change request requires
and keep every other field exactly as it is — each changed field is a revision the reviewer must read.

## Context

- CR {{cr_id}}: {{title}}
- Description: {{description}}
- Clarification answers: {{answers}}
- Writing rules of the section that owns these elements:
{{owner_skill}}
- Locations (`[L001] element path (section; why it was found)` then the element's current value as JSON):
{{locations}}
- Glossary: {{glossary}}

## Rules

1. Every location gets a `conclusion` and a one-sentence `reason` in the document's language. A location without a
   conclusion blocks submission.
2. `edit` ⇒ `spine_ops` changes **this location's element** (the path given, or a field under it). Paths by key,
   never by index: `{ "op": "set", "path": "actors[id=A02].name", "value": "Student" }`,
   `{ "op": "set", "path": "nfrs[id=NFR-01].threshold", "value": "1 s" }`. Text fields keep the document's language,
   numbering and codes. A free-form section (`custom_sections[id=…]`) changes by setting its `blocks` array.
   Never change an `id`. Adding a new element (`"path": "business_rules[]"`) is allowed only when the CR asks for it.
3. `comment` ⇒ the element may need a change you cannot make safely (a diagram, a decision for the stakeholder).
   Nothing changes; `comment_text` tells the reviewer what to check. No `spine_ops`.
4. `not_related` ⇒ the search hit is a false positive (same word, different meaning); say why. No `spine_ops`.
5. When a location lists "Previous proposal failed checks", fix exactly that problem.

## Output

JSON only:

```json
{ "locations": [
  { "location_id": "L001", "conclusion": "edit", "reason": "The actor is renamed by the CR.",
    "spine_ops": [ { "op": "set", "path": "actors[id=A01].name", "value": "Student" } ] },
  { "location_id": "L002", "conclusion": "not_related", "reason": "\"learner\" here is the course level, not the actor.", "spine_ops": [] } ] }
```
