---
skill_id: cr-propose
kind: action
version: 2.11.0
description: Mode 1 C-4 - for every affected Spine element conclude edit | comment | not_related and propose the Spine ops
provider: anthropic
aiModel: claude-haiku-5-5
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
and keep every other field exactly as it is - each changed field is a revision the reviewer must read.

## Context

- CR {{cr_id}}: {{title}}
- Document language: {{document_language}}
- Description: {{description}}
- Clarification answers (an empty answer means "I don't know"; when rounds disagree, the later round wins): {{answers}}
- Source material attached by the user (the requester's own documents - the primary source of facts):
{{materials}}
- Facts the clarify step reported as still missing: {{missing_info}}
- Where this change belongs (named by the requester, or found):
{{target_sections}}
- Writing rules of the section that owns these elements:
{{owner_skill}}
- Locations (`[L001] element path (section; why it was found)` then the element's current value as JSON):
{{locations}}
- Shape of the elements in those arrays (`*` = required field, nothing else allowed):
{{element_schemas}}
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
   avoid duplicates; "Ids already used" lists every id). Its only valid `edit` is `add` ops into **that same array**: add
   every element the change needs that does not exist yet - asked for explicitly *or* required to carry the change
   out (a new stored data concept ⇒ a new entity with its fields and relations; a new access rule ⇒ a new permission;
   a new screen ⇒ a new screen). Give a new element an id in the document's scheme (`UC-126`, `SCR-85`) that is
   **not** in "Ids already used" - the server renumbers a clashing id and the references to it in the other new
   elements of this CR. Text in the document's language. Nothing new needed ⇒ `not_related` with the reason. Never touch another array from such a location.
   Reference fields (`actor_id`, `role_id`, `screen_id`, `entity_id`, relations…) point to **existing elements
   by id** whenever one matches (a new role "Chủ bếp" ⇒ `actor_id` of the actor named "Chủ bếp") - never leave them
   empty when a match exists. Elements added by another add location of the same CR can be referenced by the ids
   you give them (all ops apply together, in location order). A section made of several arrays is only done when
   **all** its parts are filled: Screen Authorization = roles **and** the permissions matrix (`permissions[]`: one
   element per role × screen that may be accessed, `action` like "view" / "edit"); adding roles alone leaves the
   table empty.
4. Diagrams (use case, entity–relationship, screen flow, context) are **drawn from the elements** - change a diagram
   by editing or adding those elements (rules 2–3), never by a comment. `comment` ⇒ only a decision the stakeholder
   must make, or a change no op can express. Nothing changes; `comment_text` tells the reviewer what to check. No
   `spine_ops`. If the change needs a new element and this location's section has an ADD NEW / EMPTY SECTION
   location in the list, add it there instead of commenting here.
5. When *Where this change belongs* names a section, the new or changed content goes **there**: new elements only
   through that section's add location, even if it is not in this batch. Never move the content into another
   section's element (an NFR, a screen description, an actor) as a substitute, and never add new elements from an
   element location - conclude `not_related` (or edit only what truly changes in this element) instead.
6. `not_related` ⇒ the search hit is a false positive (same word, different meaning); say why. No `spine_ops`.
7. When a location lists "Previous proposal failed checks", fix exactly that problem.
8. Facts (numbers, thresholds, rules, actors, flows, fields, names) come only from the CR, the answers, the attached
   material and the current document. Prefer the material's exact wording and numbers. When a fact the content
   needs is not there, still write a reasonable value, and add one short line per invented fact to that location's
   `assumptions`, in the document's language (`"Giả định thời gian phản hồi tối đa 2 giây"`). Never invent a fact
   silently; `assumptions` is `[]` when everything came from the inputs.
9. **Contradiction answered** (an answer to a question quoting the CR against existing content): "change it to follow
   the CR" ⇒ also edit the old element / passage that said otherwise so the document no longer says both (a passage
   kept verbatim: set that `custom_sections` element's `blocks`, changing only the conflicting sentence); when no op
   can express it, conclude `comment` naming the passage to fix. "keep it as it is" ⇒ do not change that content.
10. **Language.** All new or changed text - values in `spine_ops`, `reason`, `comment_text`, `assumptions` - is in the
    *Document language* above, matching the language and terms the element's current value and the glossary already
    use (a Vietnamese document gets a Vietnamese step "Sau khi GVCN lưu điểm danh, …", never an English one "After the
    teacher saves…"; a new label in `flows_in` / `flows_out` follows the existing labels). Never translate content
    into the language of the change request or the material. Names quoted from the document or the CR keep their
    original form. A proposal with text in another language fails the checks and is redone.
11. `reason`, `comment_text` and `assumptions`: User-facing text never quotes internal ids: no section ids (`fixed:2.2.1`, `feature:@B0012`), element paths (`actors[id=A02].name`), block ids (`B0012`), location ids (`L001`) or file paths of embedded images (`word/media/image1.png`, `image_ref`; call a picture "the figure"). Name a section by its heading and an element by its name or document code (`UC-01` is fine).
12. **Unreasonable request - warn, do not draft.** When doing what the CR asks at this location would clearly harm
    the document (it contradicts a rule the document keeps, breaks a law or constraint the document states, makes two
    requirements impossible together, or removes something other parts depend on) and the location does **not** say
    "requester chose to proceed": set `warning` = `{ "text": one sentence naming the problem, "reason": one sentence
    why it is unreasonable }`, `conclusion` = `comment`, `comment_text` = the warning, **no** `spine_ops`. The
    requester then decides to proceed or drop it. A location marked "chose to proceed" (or a clarification answer
    "Vẫn làm" / "Proceed" to a warning about it) is **never** warned again: draft the edit as asked. Ordinary
    requests, even unusual ones, are not warnings - warn only on a real conflict. `warning` is `null` otherwise.
13. **Out of scope sections.** A location marked OUT OF SCOPE belongs to a section the file kept verbatim and FlintFlow
    does not write. With existing content: only a text edit (set that element's `blocks` changing just the words the
    CR names, same structure); no new elements, no rule reasoning. Empty: conclude `comment` only.
14. **Text rules.** Text you write for people (`reason`, `comment_text`, `assumptions`, `warning`, new content)
    never uses the long dash character (use a hyphen " - ") and never contains the letters "FPT" (say "FlintFlow
    standard template").

15. **Shape of new values.** Every value you put in `spine_ops` (an `add` element, a `set` of a field) follows the shape
    in *Shape of the elements* exactly: only the listed fields, the listed types, every required (`*`) field present,
    enum values and patterns respected (a pattern such as `^[a-z]+( [a-z]+)*$` means lowercase English words only,
    whatever the document language). Never invent a field (`type`, `references`) and never turn a list of strings into
    objects. Unsure of a field ⇒ leave the optional ones out.
16. **Removing a whole element.** The CR drops the element this location is (a function, a screen, a use case, a
    message...) ⇒ `conclusion: edit` and `spine_ops: [ { "op": "remove", "path": "functions[id=FN012]" } ]` with the
    element's own path. The code removes the references to it by itself. A comment that tells the reviewer to delete it
    is **not** a substitute: the element would stay in the document. Removing the last function of a use case that is in
    the list ⇒ also `remove` that use case.
17. **Adding a whole function / screen.** The CR adds a function (or a screen) ⇒ from the location `functions[]` /
    `screens[]` of the feature that holds it, `add` the complete element (id in the document's scheme, `feature_id` of
    that feature, `screen_id` of the screen it belongs to when it has one, trigger, description, normal / abnormal
    flows, validations). "Add this function" as a comment is never an answer when such a location is in the list. A use case
    location in the list ⇒ `set` its `function_ids` to the old list plus the new function id.
18. **Passage that mentions a removed element** (found by `mention`, about an element the CR removes): rewrite or drop
    exactly that sentence so the document no longer refers to it (set that element's text or the `blocks` of that
    `custom_sections` element, changing only that sentence). The sentence does not mention it any more after the edit ⇒ done.
19. **Changing a value.** The CR changes a value (a number, a duration, an amount): change **every place in this element**
    that states the old value with the same meaning (normal and abnormal flows, validations, interactions, guards, description),
    not only the one the reason mentions. Leave a place unchanged only when the number means something else, and say so in `reason`.

## Output

JSON only:

```json
{ "locations": [
  { "location_id": "L001", "conclusion": "edit", "reason": "The actor is renamed by the CR.",
    "spine_ops": [ { "op": "set", "path": "actors[id=A01].name", "value": "Student" } ], "assumptions": [] },
  { "location_id": "L002", "conclusion": "not_related", "reason": "\"learner\" here is the course level, not the actor.", "spine_ops": [] },
  { "location_id": "L003", "conclusion": "comment", "reason": "The CR conflicts with a kept rule.", "comment_text": "Removing the login step breaks BR-02.",
    "spine_ops": [], "warning": { "text": "Removing the login step breaks BR-02.", "reason": "BR-02 requires every order to be placed by a signed-in user." } } ] }
```
