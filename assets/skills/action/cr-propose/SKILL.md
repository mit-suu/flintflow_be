---
skill_id: cr-propose
kind: action
version: 2.4.0
description: Mode 1 C-4 — for every affected Spine element conclude edit | comment | not_related and propose the Spine ops
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 6144
temperature: 0.2
reads:
  - "<change request + clarification answers>"
  - "<source material the user attached + facts the clarify step reported missing>"
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
- Clarification answers (an empty answer means "I don't know"): {{answers}}
- Source material attached by the user (the requester's own documents — the primary source of facts):
{{materials}}
- Facts the clarify step reported as still missing: {{missing_info}}
- Where this change belongs (named by the requester, or found):
{{target_sections}}
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
   Never change an `id`. New elements are added only from a whole-array location (rule 3), never from here.
3. A location whose path is a whole array (`other_requirements[]`, `entities[]`) is where **new elements** are added.
   **EMPTY SECTION** = the section has no elements yet; **ADD NEW** = it has some (listed as the value, so you can
   continue the id scheme and avoid duplicates). Its only valid `edit` is `add` ops into **that same array**: add
   every element the change needs that does not exist yet — asked for explicitly *or* required to carry the change
   out (a new stored data concept ⇒ a new entity with its fields and relations; a new access rule ⇒ a new permission;
   a new screen ⇒ a new screen). Ids continue the document's scheme (`E-07`, `BR-07`…), text in the document's
   language. Nothing new needed ⇒ `not_related` with the reason. Never touch another array from such a location.
   Reference fields (`actor_id`, `role_id`, `screen_id`, `entity_id`, relations…) point to **existing elements
   by id** whenever one matches (a new role "Chủ bếp" ⇒ `actor_id` of the actor named "Chủ bếp") — never leave them
   empty when a match exists. Elements added by another add location of the same CR can be referenced by the ids
   you give them (all ops apply together, in location order). A section made of several arrays is only done when
   **all** its parts are filled: Screen Authorization = roles **and** the permissions matrix (`permissions[]`: one
   element per role × screen that may be accessed, `action` like "view" / "edit"); adding roles alone leaves the
   table empty.
4. Diagrams (use case, entity–relationship, screen flow, context) are **drawn from the elements** — change a diagram
   by editing or adding those elements (rules 2–3), never by a comment. `comment` ⇒ only a decision the stakeholder
   must make, or a change no op can express. Nothing changes; `comment_text` tells the reviewer what to check. No
   `spine_ops`. If the change needs a new element and this location's section has an ADD NEW / EMPTY SECTION
   location in the list, add it there instead of commenting here.
5. When *Where this change belongs* names a section, the new or changed content goes **there**: new elements only
   through that section's add location, even if it is not in this batch. Never move the content into another
   section's element (an NFR, a screen description, an actor) as a substitute, and never add new elements from an
   element location — conclude `not_related` (or edit only what truly changes in this element) instead.
6. `not_related` ⇒ the search hit is a false positive (same word, different meaning); say why. No `spine_ops`.
7. When a location lists "Previous proposal failed checks", fix exactly that problem.
8. Facts (numbers, thresholds, rules, actors, flows, fields, names) come only from the CR, the answers, the attached
   material and the current document. Prefer the material's exact wording and numbers. When a fact the content
   needs is not there, still write a reasonable value, and add one short line per invented fact to that location's
   `assumptions`, in the document's language (`"Giả định thời gian phản hồi tối đa 2 giây"`). Never invent a fact
   silently; `assumptions` is `[]` when everything came from the inputs.
9. `reason`, `comment_text` and `assumptions`: User-facing text never quotes internal ids: no section ids (`fixed:2.2.1`, `feature:@B0012`), element paths (`actors[id=A02].name`), block ids (`B0012`) or location ids (`L001`). Name a section by its heading and an element by its name or document code (`UC-01` is fine).

## Output

JSON only:

```json
{ "locations": [
  { "location_id": "L001", "conclusion": "edit", "reason": "The actor is renamed by the CR.",
    "spine_ops": [ { "op": "set", "path": "actors[id=A01].name", "value": "Student" } ], "assumptions": [] },
  { "location_id": "L002", "conclusion": "not_related", "reason": "\"learner\" here is the course level, not the actor.", "spine_ops": [] } ] }
```
