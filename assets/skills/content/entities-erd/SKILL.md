---
skill_id: entities-erd
kind: content
version: 0.11.0
description: "S-4.5 domain entities and their relations, feeding the ERD renderer"
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 12288
temperature: 0.2
reads:
  - "entities[]"
  - "features[].name"
  - "project.release_scope"
  - "actors[]"
  - "use_cases[].name"
  - "screens[].name"
  - "functions[].name/.description"
  - "assumptions[origin_step_id=S-4.5]"
  - "business_rules[].statement"
writes:
  - "entities[]"
  - "assumptions[]"
output_schema: opTransaction
language: en
stub: false
---
# Entities And ERD

Covers **S-4.5 Entity Relationship Diagram** — feeds `fixed:3.1.5`. The `erd` diagram (Chen notation: a
rectangle per entity, a diamond holding a verb per relation) is rendered straight from `entities[]`,
which is also the §3.1.5 table. `references/*.md` are **not loaded at runtime**; every rule is below.
Work through the passes **in order**; skipping one produced the wrong ERDs listed near the end.

## Shape

`{id, name, description, root?, relations: [], relation_verbs: {}, relation_cardinality: {}, relation_optional: []}`

- `name`: singular, Title Case, English, unique. Never ends in List, Screen, Page, Form, Popup, Modal,
  Dialog, Service, Manager, Controller, DTO or Table.
- `description`: one grammatical sentence — what **one** instance is and whose it is. No attribute list
  (§3.1.5 is a relationship map; field rules live in S-5.4 and S-7.1).
- `root`: `true` only for master data that exists on its own (Pass 2). Omit it on every other entity.
- `relations`: ids of this entity's **children** (the "many" side). Every id exists after this batch.
- `relation_verbs`: one verb per id in `relations` — the word in the diamond.
- `relation_cardinality`: `{"<child id>": "1"}` only for a proven one-to-one (Pass 3a); omitted = `N`.
- `relation_optional`: child ids that can exist **without** this parent (Pass 3, step 2).

**Linked** below always means one of three things, nothing else: B is a **direct parent** of A; B is an
**ancestor** of A through the parent chain; or A and B share an **associative child**.

## Pass 1 — Inventory (every function, one by one)

For **each function** in the projection, name the stored things it creates, reads or changes, then
classify each noun:

| The noun is… | Model it as |
| --- | --- |
| a thing the product keeps and a user can name | an entity |
| a property of another thing (status, score value, deadline, capacity) | nothing here — it is a field |
| computed on demand (statistics, dashboard, report on screen) | nothing — say so in `notes` |
| listed under `release_scope.out` | nothing |

| Function says | Model |
| --- | --- |
| Create / Edit / Delete / Archive X | X |
| Manage A, B and C | A, B and C, each its own entity |
| Assign X to Y · Allocate X to Y | an assignment entity (`Seat Assignment`), child of both X and Y |
| Register for X · Enrol in X · Book X | a registration entity, child of **User** and of X |
| Request / Appeal / Report / Swap on X | a request entity, **child of X** (it is raised against X) |
| Approve / Publish / Lock / Confirm X | a status of X — no new entity |
| Import X from a file | the import batch as an entity; X as its own entity, optional child of the batch |
| Notify · Send email | Notification, child of User |
| Log · Audit | Audit Log, child of User |
| View / Search / Filter / Export X | X only — the act itself stores nothing |

Also sweep machinery that is always stored but rarely on a screen: credits, payment, notification, audit
log, uploaded file, AI usage. Fewer than 8 entities for 20+ functions means the inventory was skipped.
Merge while you go: entities that differ only by status or kind (`Retake Registration` vs
`Exam Registration`) are one entity with a kind field.

## Pass 2 — Roots and dependents

- **Root** (`root: true`) — master data that exists on its own: User, Course, Semester, Building, Exam
  Room, Product. A root may have no parent; it may still have one (Building contains Exam Room).
- **Dependent** — only makes sense *of*, *for*, *in* or *against* something else: Exam Paper (for a
  course), Seat Assignment (in a room, for a registration), Regrade Appeal (against a score).

**Every dependent has at least one direct parent.** Take the candidates from what its description says
it is *of / for / in / against / from*, and keep at least one of them as a direct parent (decide which
with Pass 3). A dependent linked only through its own child (Exam Paper reached only via Paper Question)
is floating. An entity with no parent and no `root: true` is rejected.

## Pass 3 — Decide each relation

Every edge is drawn one (parent) to many (child). For each pair you connect, in this order:

1. **Two questions.** "Can one A have many B?" and "Can one B have many A?" Answer **no** only when a
   business rule, function or confirmed assumption says so; when unsure, the answer is **yes**.
   - yes / no → A is the parent: `A.relations` has B. no / yes → B is the parent.
   - yes / yes → many-to-many: an associative entity, child of both (`Exam Paper ↔ Question` becomes
     `Paper Question`: `Exam Paper contains Paper Question`, `Question appears in Paper Question`).
     Never A → B plus B → A.
   - no / no (both proven) → one-to-one: merge unless owner or lifecycle differ; if kept, the one that
     exists first is the parent, and Pass 3a writes `"1"` with the same evidence.
2. **Existence.** The parent exists before its children. A record **raised against** another is its
   child: `Score Record receives Regrade Appeal`, never the reverse. If the child can also exist
   **without** this parent (a registration made by the student has no import batch), the link is
   **optional**: keep it only when a function really records it, list the child in `relation_optional`,
   and say "optionally" in the child's description. A child needs at least one **mandatory** parent.
3. **Read back.** "One <parent> <verb> many <children>" must be true in this domain. "One Exam Schedule
   hosts many Exam Rooms" is false — the direction is wrong; flip it before choosing the verb.
4. **Verb.** Lowercase English, 1–3 words, active voice, read parent → child: `contains`, `owns`,
   `places`, `issues`, `records`, `hosts`, `receives`. Take it from the function that creates the child
   ("Register for Exam" → `User makes Exam Registration`). Never passive or child → parent (`belongs to`,
   `is part of`, `owned by`, `assigned to`, `linked to`, `derived from`, `contained in`, `applies to`), a
   noun or a cardinality. A rejected verb means **rephrase from the parent's side** — never flip a
   direction you decided in steps 1–3 to fit a verb. Use `has` only when nothing more precise is true.
5. **No shortcut.** When A → B → C exists, do not also relate A → C; the owner of C is reached
   through B (`User → Regrade Appeal` is redundant beside `User → Exam Registration → … → Score Record →
   Regrade Appeal`). Keep A → C only for a *different person in a different role*, and the verb names
   that role (`User invigilates`, `User reviews`).
6. **Self-relation** only for a real tree (Comment → Comment); no duplicate id in one `relations` array.

## Pass 3a — Cardinality from evidence

The child side of every relation is `N` unless evidence proves `"1"`. For each relation, answer "can one
parent ever have a **second** child?":

1. **Collect evidence**, strongest first: a confirmed S-4.5 assumption › a business rule (`BR..`) › a
   function description (`FN..`) › a use case name (`UC..`).
2. **Repetition check.** Search that evidence for the child repeating under the **same** parent: retake,
   resit, retry, re-attempt, resubmit, reopen, again, history, version, renewal, "each time", "multiple",
   "at most N" with N > 1. Found → `N`.
3. **Where does the repeat live?** A repeat that creates a **new parent** keeps the child `"1"`: "Register
   for Retake Exam" creates a *new* Exam Registration, so each registration still leads to one attempt.
   A repeat under the **same** parent ("re-attempt within the same registration") makes it `N`. Say which
   in both descriptions ("One attempt per registration; a retake is a new registration.").
4. **Limits.** "At most one / exactly one X per Y" → `"1"` on the Y → X relation.
5. **Chained reasoning.** If an argument uses another relation being one-to-one ("one appeal per
   attempt, and an attempt has one score"), that other relation must be `"1"` too, with its own evidence.
   An assumption that relies on "one X" while the parent → X edge is still `N` is rejected.
6. **No evidence either way** → `N`.
7. **Write it down.** Every `"1"` has an `assumptions[]` entry whose path is
   `entities[id=<parent>].relation_cardinality`, whose statement names the child entity, and whose
   `rationale` cites the evidence ids (`FN009`, `BR55`, `AS29`). A confirmed assumption already covering
   it is enough — repoint its path instead of adding a new one.

## Pass 4 — People

For every human actor, ask of each of its functions "which record does this person create, own or get
assigned to?" — each answer is a relation from `User` (roles are data on User, not entities):

- the author or owner: `User authors Question`, `User makes Exam Registration`;
- the person assigned: through the assignment entity — `User takes Invigilator Assignment`;
- the person who raises a request, unless User is already its ancestor as the same person.

A record a function says a named role creates ("a lecturer assembles the paper") must be **linked** to
User; a different role acting on it (reviewer, invigilator) needs its own direct relation.

## Pass 5 — Descriptions agree with relations

- Every entity a description names is **linked** to it (definition above). Otherwise add the relation
  (Pass 3) or reword the description to what is actually stored.
- A named thing that is not an entity yet ("per semester", "the FAP file") is added (Pass 1) or dropped
  from the description.

## Pass 6 — Normal form (3NF at entity level)

1. **1NF** — an entity never holds a list of another thing ("Exam Paper with its questions"): the list is
   a child, or an associative entity when the listed thing is shared.
2. **2NF** — an associative entity only describes the pairing (order and mark of a question *in that
   paper*); facts of one parent stay on that parent.
3. **3NF** — one entity, one thing. A description covering a second thing ("Exam Schedule with its room
   capacity") is two entities; facts of another entity are reached through the relation, never copied.
   User-maintained value sets (faculties, buildings) are entities; fixed code constants stay enums.

## Errors seen in earlier runs

| Wrong | Right |
| --- | --- |
| `Regrade Appeal contests Score Record` (flipped to dodge a passive verb) | `Score Record receives Regrade Appeal` |
| `Exam Session examines Course` · `Exam Schedule → Exam Room` | `Course schedules Exam Session` · `Exam Room hosts Exam Schedule` |
| `Exam Paper → Question` one-to-many, AS30 confirmed "many papers, many questions" | `Paper Question` between them |
| `Exam Paper` linked only to `Paper Question` | a direct parent: `Course owns Exam Paper` |
| `Retake Registration` beside `Exam Registration` | one `Exam Registration` with a kind |
| `Import Batch creates Exam Registration` as a mandatory parent | optional: listed in `relation_optional` |
| AS75 "an attempt produces one score record", `Exam Attempt → Score Record` drawn `N` | make it `"1"` with evidence, or drop the claim |
| `User → Exam Attempt`, `User → Score`, `User → Appeal` | only `User makes Exam Registration`; the rest hang below it |

## Enforced on your batch

Checked on the whole ERD **after** your batch (existing entities too — fix them in the same batch). A
failure **rejects** the batch and sends it back to you with the reason:

| Rule | Rejected when |
| --- | --- |
| `erd_disconnected` | the ERD is not one connected graph |
| `erd_dependent_without_parent` | an entity has no parent and no `root: true` |
| `erd_relation_verb_missing` / `_extra` | a relation has no verb, or a verb / cardinality / optional entry has no relation |
| `erd_relation_verb_passive` | a verb is passive or reads child → parent |
| `erd_many_to_many` · `erd_confirmed_many_to_many` | A → B and B → A · a confirmed many-to-many drawn as a direct edge |
| `erd_relation_cycle` | parent chains loop (A → B → C → A) |
| `erd_duplicate_name` / `erd_entity_name_invalid` | two entities share a name, or a name is a screen/service word |
| `erd_cardinality_unset` / `_unjustified` | an assumption points at an unset cardinality · a `"1"` has no assumption naming the child |
| `erd_cardinality_no_evidence` | an unconfirmed cardinality assumption cites no `FN`/`BR`/`UC`/`AS` id |
| `erd_cardinality_contradiction` | an assumption relies on "one X" while the parent → X edge is `N` |
| `erd_description_unlinked` | a description names an entity (exact name) that is not **linked** to it |

Passing these checks is necessary, not sufficient: the reasoning in Passes 2–5 is yours.

## Rules

1. Ids continue the existing sequence (`draft-to-ops` rule 5); a dangling id is `dead_reference`.
2. English, no diacritics, no section numbers (`draft-to-ops` 6–7); write only entities and assumptions.
3. A **confirmed** S-4.5 assumption is the user's decision: model it exactly, and `set` its `path` to the
   entity or field that now carries it. Remove an unconfirmed one your ERD no longer needs.
4. `notes`: one line per noun from Pass 1 that did **not** become an entity, with why (field, computed,
   out of scope, merged into X).

## Example

```json
{
  "ops": [
    { "op": "add", "path": "entities[]", "value": { "id": "E01", "name": "User", "description": "One person who signs in, with a role such as student or lecturer.", "root": true, "relations": ["E05"], "relation_verbs": { "E05": "makes" } }, "reason": "S-4.5 root; Register for X pattern" },
    { "op": "add", "path": "entities[]", "value": { "id": "E02", "name": "Course", "description": "One subject of the curriculum with its own question bank.", "root": true, "relations": ["E03", "E04"], "relation_verbs": { "E03": "owns", "E04": "schedules" } }, "reason": "S-4.5 root" },
    { "op": "add", "path": "entities[]", "value": { "id": "E03", "name": "Exam Paper", "description": "One paper assembled for one course from its question bank.", "relations": [] }, "reason": "S-4.5 dependent of Course" },
    { "op": "add", "path": "entities[]", "value": { "id": "E04", "name": "Exam Slot", "description": "One timed sitting of one course in which candidates take the exam.", "relations": ["E05"], "relation_verbs": { "E05": "accepts" } }, "reason": "S-4.5 dependent of Course" },
    { "op": "add", "path": "entities[]", "value": { "id": "E05", "name": "Exam Registration", "description": "One user's registration for one exam slot; a retake is a new registration.", "relations": ["E06"], "relation_verbs": { "E06": "produces" }, "relation_cardinality": { "E06": "1" } }, "reason": "S-4.5 child of User and Exam Slot" },
    { "op": "add", "path": "entities[]", "value": { "id": "E06", "name": "Exam Attempt", "description": "The one sitting an exam registration leads to, present or absent.", "relations": [] }, "reason": "S-4.5 one-to-one kept: created at exam time" },
    { "op": "add", "path": "assumptions[]", "value": { "id": "AS15", "path": "entities[id=E05].relation_cardinality", "statement": "Each exam registration leads to exactly one exam attempt; a retake is a new registration.", "rationale": "FN009 creates a new registration for a retake; no function re-opens an attempt on the same registration.", "origin_step_id": "S-4.5", "status": "unconfirmed", "confirmed_at": null }, "reason": "S-4.5 Pass 3a evidence" }
  ],
  "notes": "Exam statistics: computed on screen, not stored. Publish Schedule: a status of Exam Slot."
}
```

## Self-check

- [ ] Pass 1: every function mapped; assignments, registrations and requests follow the pattern table.
- [ ] Pass 2: every entity is `root: true` or has a direct parent; no floating dependent.
- [ ] Pass 3: "no" only with evidence; verbs active parent → child, none flipped; no shortcut.
- [ ] Pass 3: every optional link is in `relation_optional`; every child has a mandatory parent.
- [ ] Pass 3a: every `"1"` survived the repetition check, cites evidence, and relies on no `N` edge.
- [ ] Pass 4: every person who authors, owns or is assigned a record is linked to it from User.
- [ ] Pass 5: every entity a description names is linked to it.
- [ ] Pass 6: no list inside an entity; no description covering two things.
- [ ] Every confirmed S-4.5 assumption modelled; `notes` lists the nouns that are not entities.
