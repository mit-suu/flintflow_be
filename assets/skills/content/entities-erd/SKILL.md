---
skill_id: entities-erd
kind: content
version: 0.3.0
description: "S-4.5 domain entities and their relations, feeding the ERD renderer"
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 6144
temperature: 0.3
reads:
  - "entities[]"
  - "features[]"
  - "screens[]"
  - "functions[]"
writes:
  - "entities[]"
  - "assumptions[]"
output_schema: opTransaction
language: en
stub: false
---
# Entities And ERD

Covers **S-4.5 Entity Relationship Diagram** — feeds `fixed:3.1.5`. The step renders the `erd` diagram
straight from what you write here, so `entities[]` is both the table in §3.1.5 and the source of the
picture. `references/*.md` are **not loaded at runtime**; rules are inlined below.

## What an entity is

A thing the product **stores and the user can name**: Project, Document, Actor, Credit Wallet, Payment,
Notification. Not: a screen, a service, a queue, a DTO, a controller, an enum, a join table, or anything
whose only job is plumbing. If two entities differ only by status (`DraftProject`, `ArchivedProject`),
they are one entity with a status field.

Shape: `{id, name, description, relations: []}`.

- `name`: singular, Title Case, English ("Credit Reservation", not "credit_reservations").
- `description`: one sentence — what it holds and who owns it. Attributes are **not** listed here; §3.1.5
  is a relationship map, and per-field rules live in `validations[]` (S-5.4) and `business_rules[]` (S-7.1).
- `relations`: ids of other entities this one is related to (`entities[].relations[]` is a reference
  field — every id must exist after this batch).

## Finding the entities

Sweep three sources; for each hit either add the entity or say in `notes` why it is not stored:

1. **Screens and functions.** Every list/detail screen pair implies the entity it lists. Every function
   named "Create X" / "Export X" / "Archive X" implies X.
2. **Actors and roles.** `actors[kind=human]` almost always maps to a `User`/`Account` entity; roles and
   permissions imply a membership or role-assignment entity when they are data rather than code constants.
3. **Cross-cutting machinery the Brief mentions.** Credits/wallet, payment/invoice, notification,
   audit log, uploaded file/document, AI usage record. These rarely have their own screen but are always
   stored, and are the entities reviewers find missing.

8–20 entities is the usual range for one release. Fewer than 5 means the sweep was skipped.

## Relations

`relations` has **no cardinality field** — the renderer draws every edge as one-to-many
(`||--o{`). So:

1. Put the id on the **parent** side (the "one"): `Project.relations` includes `Document`, not the other
   way round. Getting this backwards silently draws the ERD upside down.
2. For a genuine many-to-many, name the join as its own entity when it carries data of its own
   (`ProjectMember` with a role and joined-at) and relate both parents to it. When it carries nothing,
   put the id on the more stable side and note the real cardinality in an `assumptions[]` entry.
3. No self-relation unless the entity really is a tree (Comment → Comment), and no duplicate ids in one
   `relations` array.
4. Every entity should touch at least one other entity. An island is either missing a relation or is not
   part of this product.

## Rules

1. Ids continue the existing sequence (`draft-to-ops` rule 5); check the projection first.
2. Every id in `relations` exists after this batch — a dangling id is `dead_reference` and blocks the lot.
3. English values, no diacritics, no section numbers in prose (`draft-to-ops` rules 6–7).
4. Do not write `screens[]`, `functions[]` or `business_rules[]` here.
5. Fast mode: add the entity with the most reasonable relation direction plus an `assumptions[]` entry
   (`status: "unconfirmed"`); Coaching mode leaves the open question for Elicit (`draft-to-ops` rule 10).

## Example (parent with two children and a noted many-to-many)

```json
{
  "ops": [
    { "op": "add", "path": "entities[]", "value": { "id": "E01", "name": "Project", "description": "A requirements effort owned by one author, holding the whole generated document.", "relations": ["E02", "E03"] }, "reason": "S-4.5 root entity" },
    { "op": "add", "path": "entities[]", "value": { "id": "E02", "name": "Document Version", "description": "An assembled snapshot of a project's SRS at a point in time.", "relations": [] }, "reason": "S-4.5 child of Project" },
    { "op": "add", "path": "entities[]", "value": { "id": "E03", "name": "Chat Session", "description": "One conversation thread attached to a project.", "relations": [] }, "reason": "S-4.5 child of Project" },
    { "op": "add", "path": "assumptions[]", "value": { "id": "AS15", "path": "entities[id=E01].relations", "statement": "A project has exactly one owner; sharing with collaborators is out of this release.", "rationale": "Release scope lists sharing as out of scope.", "origin_step_id": "S-4.5", "status": "unconfirmed", "confirmed_at": null }, "reason": "S-4.5 cardinality not stated" }
  ],
  "notes": "Credit Wallet and Payment already existed from the billing sweep."
}
```

## Self-check

- [ ] Every entity is a stored, user-nameable thing — no screens, services, queues or enums.
- [ ] `name` singular Title Case; `description` one sentence, no attribute list.
- [ ] Relation ids sit on the parent ("one") side and all exist after this batch.
- [ ] No island entity, no duplicate id inside a `relations` array.
- [ ] Credits/payments, notifications, uploaded files and audit records are present or explained.
- [ ] Real many-to-many cardinality either modelled as its own entity or recorded as an assumption.
