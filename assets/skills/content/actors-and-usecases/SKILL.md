---
skill_id: actors-and-usecases
kind: content
version: 0.2.0
description: "S-3.1–S-3.5 actors, roles, actor–goal list, missing use case sweep, relationships, descriptions"
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 6144
temperature: 0.3
reads:
  - "actors[]"
  - "roles[]"
  - "use_cases[]"
  - "functions[].id"
  - "addendum[]"
writes:
  - "actors[]"
  - "roles[]"
  - "use_cases[]"
output_schema: opTransaction
language: en
stub: true
---
# Actors And Usecases

> `stub: true` is kept only so `prompt-assets.test.ts` (T03, owned file) keeps passing — it asserts every
> non-`action` skill is a stub. Content below is real, written in T14. XREQ T14→T03: split that assertion
> once T03 revisits it.

Covers **S-3.1 Actors, S-3.2 Actor–Goal List, S-3.3 Missing Use Case Sweep, S-3.4 Use Case Relationships,
S-3.5 Use Case Descriptions** — feeds `fixed:2.1` (Actors) and `fixed:2.2.2` (Use Case Descriptions).
`fixed:2.2.1` (the diagram) is `S-3.6`, render-only, no skill. This is the audit gap this task closes
(B5/B6): actor/use-case discovery is BMAD's weakest coverage, so read the four references below in full
before drafting — do not rely on this file's summary alone.

## Context (per step)

- Step: **{{step_id}}** — {{step_name}} · Fields this step may write: {{writable_paths}}
- Projection: {{projection}} — current `actors[]`, `roles[]`, `use_cases[]`, `functions[].id`
- Addendum for this step: {{addendum}}

## S-3.1 — Actors

Add every human, system and time actor implied by the Brief, addendum and any `actors[kind=system]`
already added at S-2.3 (do not duplicate those). Add one `roles[]` per human actor that needs a distinct
permission set (`actor_id` set, `roles[]` never left orphaned — `references/actor-rules.md`). Time actors
(schedulers, cron triggers) never get a role.

## S-3.2 — Actor–Goal List

For each actor, list what it needs to accomplish; each goal becomes one `use_cases[]` candidate:
`{name: verb + object, actor_ids: [...], function_ids: [], description, includes: [], extends: []}`.
Naming rules: `references/usecase-naming.md`.

## S-3.3 — Missing Use Case Sweep

Run the checklist in `references/missing-usecase-checklist.md` (admin, support, notifications, forgotten
password, audit log, error handling) against the actor list — add any use case the goal list missed.

## S-3.4 — Use Case Relationships

Set `includes[]`/`extends[]` on existing use cases per `references/include-extend.md`. Never invent a new
use case here — only wire relationships between ones already added at S-3.2/S-3.3.

## S-3.5 — Use Case Descriptions

Finalize `description` for every use case not yet fully worded (one sentence: actor, trigger, outcome).
Table shape for the rendered section: `assets/usecase-table-template.md`.

## Rules

1. `function_ids` stays `[]` for every use case — functions do not exist until S-4; wiring happens then.
2. New actor/use-case ids continue the existing sequence (`draft-to-ops` rule 5); check the projection.
3. English, no diacritics, no section numbers in prose (`draft-to-ops` rules 6–7).
4. `includes`/`extends` only reference use case ids already present after this batch (own adds count).

## Example (S-3.1, one human actor + role)

```json
{
  "ops": [
    { "op": "add", "path": "actors[]", "value": { "id": "A01", "name": "Founder / Business Analyst", "kind": "human", "description": "Drives the guided Brief-to-SRS pipeline for their own project." }, "reason": "S-3.1 primary human actor from Brief" },
    { "op": "add", "path": "roles[]", "value": { "id": "R01", "name": "Founder", "actor_id": "A01" }, "reason": "S-3.1 role for primary actor" }
  ],
  "notes": "Primary human actor and matching role added; system actors already present from S-2.3."
}
```

## Self-check

- [ ] Every actor has `kind` correct (human/system/time) and a project-specific `description`.
- [ ] Every human actor with distinct permissions has a `roles[]` row; no orphaned role (`actor_id` valid).
- [ ] Every use case name is verb + object (`references/usecase-naming.md`), `function_ids` is `[]`.
- [ ] Sweep checklist themes covered or explicitly not applicable (`references/missing-usecase-checklist.md`).
- [ ] `includes`/`extends` only point at use case ids that exist after this batch.
