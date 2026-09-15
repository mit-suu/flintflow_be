---
skill_id: actors-and-usecases
kind: content
version: 0.3.0
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
  - "assumptions[]"
output_schema: opTransaction
language: en
stub: false
---
# Actors And Usecases

Covers **S-3.1 Actors, S-3.2 Actor–Goal List, S-3.3 Missing Use Case Sweep, S-3.4 Use Case Relationships,
S-3.5 Use Case Descriptions** — feeds `fixed:2.1` (Actors) and `fixed:2.2.2` (Use Case Descriptions).
`fixed:2.2.1` (the diagram) is `S-3.6`, render-only, no skill. This is the audit gap this task closes
(B5/B6): actor/use-case discovery is BMAD's weakest coverage. `references/*.md` are **not loaded at
runtime** (`draft-to-ops.ts#contentGuidance` calls `getSkill` without a `references` option) — every rule
needed to draft correctly is inlined below; the reference files remain extra reading for humans only.
XREQ T14→T11: have `draftOps` load `references: "all"` for skill content so these can move back out.

Projection carries current `actors[]`, `roles[]`, `use_cases[]`, `functions[].id` — the surrounding
`draft-to-ops` prompt already substitutes the actual step id, writable paths, projection and addendum
around this content; do not restate `{{...}}` placeholders here, they are not interpolated inside skill
content (only in the outer action prompt).

## S-3.1 — Actors

Add every human, system and time actor implied by the Brief/addendum and any `actors[kind=system]` already
added at S-2.3 (do not duplicate). Kinds: `human` (operates via UI, gets a role unless sharing one),
`system` (external integration, already partly seeded, no role), `time` (scheduler/cron/trigger, no UI, no
role). An actor is a type of party, not a job-title synonym — two names sharing every capability are one
actor with two `roles[]` rows, not two actors. A guided-pipeline product usually needs at least: the
primary human actor, one back-office human actor, one external system actor, and one `time` actor if
anything runs on a schedule — missing one without a stated reason is a signal to recheck the Brief.
**Derive, do not wait to be told**: a goal/vision mentioning AI generation ⇒ `system` "AI Model Provider";
credits, payments, plans ⇒ `system` "Payment Gateway"; export/email/notifications ⇒ the matching `system`
service; anything that expires, resets, is reserved or scheduled ⇒ a `time` actor (e.g. "Credit Reservation
Expiry Scheduler"). Fast mode: add them with an `assumptions[]` entry rather than skipping. One
`roles[]` row per (human actor, distinct permission set); `actor_id` must be a `human` actor's id, never
`null` at creation; add the actor before its role in the same batch.

## S-3.2 — Actor–Goal List

For each actor, list what it needs to accomplish; each goal becomes one `use_cases[]` candidate:
`{id, name: verb + object (Title Case, no actor name inside, e.g. "Draft Product Brief"), actor_ids: [every
actor that can *initiate* it — `system` actors qualify too], function_ids: [], description: "<actor,
trigger, outcome — one full sentence, written now, not deferred to S-3.5>", includes: [], extends: []}`.
One use case = one goal reachable in one sitting, independent of UI screens — "Manage Project" is too
coarse (split create/edit/delete/export); "Click Accept Button" is too fine (implementation detail).
**Coverage floor**: the primary human actor gets one use case per goal in `project.goals[]` and per
`release_scope.in` bullet (typically 6–10); every other human actor ≥ 2; every `system`/`time` actor ≥ 1
use case it initiates (e.g. "Expire Stale Credit Reservations"). Add every use case not already in the
projection — a S-3.2 batch with no new `use_cases[]` is almost always wrong.

## S-3.3 — Missing Use Case Sweep

Check each theme against the current list; for every theme without a matching use case, **add one** (Fast
mode: with an `assumptions[]` entry), or name the theme in `notes` with the reason it does not apply — never
silently skip: **(1) Administration** — an admin actor has view/list + suspend for every
entity type end users create. **(2) Support** — a human actor can reach a "something is wrong, help me"
path unless support is explicitly out of scope. **(3) Notifications** — a human actor has a use case for
consuming each async event a `system`/`time` actor produces. **(4) Forgotten password** — required for any
authenticated human actor unless auth is delegated to an external identity provider. **(5) Audit log** — an
admin actor can review destructive/high-trust actions, when any exist. **(6) Error handling** — a human
actor can recover from a failed AI action or validation rejection when the recovery involves a real
decision, not every toast notification.

## S-3.4 — Use Case Relationships

Set `includes[]`/`extends[]` on use cases already added at S-3.2/S-3.3 — never create a new use case here.
`includes[]`: the base use case **always** triggers the included one (UML `<<include>>`) — set on the base
use case. `extends[]`: an **optional** variant/continuation triggered under a condition (UML `<<extend>>`)
— set on the extending use case, not the base. Test: "does the base make sense without this happening?" —
no ⇒ `includes`; yes (a conditional branch) ⇒ `extends`. Both are `set` on an existing use case's array
field, e.g. `{ "op": "set", "path": "use_cases[id=UC02].includes", "value": ["UC06"] }`. Every referenced id
must exist in `use_cases[]` after this batch (own adds from S-3.2/S-3.3 count) — a dangling id is
`dead_reference`, rejected at validation. No self-reference, no cycles. Most use cases stay standalone —
only wire what the actor-goal analysis actually supports.

## S-3.5 — Use Case Descriptions

Finalize `description` for every use case not yet fully worded (one sentence: actor, trigger, outcome).
Table shape for the rendered section: `assets/usecase-table-template.md` (ID, Name, Actor(s), Description,
Includes, Extends — actor/use-case ids resolved to names at render time, not stored as names).

## Rules

1. `function_ids` stays `[]` for every use case — functions do not exist until S-4; wiring happens then.
2. New actor/use-case ids continue the existing sequence (`draft-to-ops` rule 5); check the projection.
3. English, no diacritics, no section numbers in prose (`draft-to-ops` rules 6–7).
4. `includes`/`extends` only reference use case ids already present after this batch (own adds count).
5. Fast mode: fill a missing actor/use-case detail with the most reasonable default and add an
   `assumptions[]` entry (`status: "unconfirmed"`) instead of leaving it out; Coaching mode leaves it for
   Elicit instead of inventing (`draft-to-ops` rule 10).

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
- [ ] Every use case name is verb + object, `function_ids` is `[]`, description written at creation.
- [ ] Sweep themes covered or explicitly not applicable (admin, support, notifications, forgotten
      password, audit log, error handling).
- [ ] `includes`/`extends` only point at use case ids that exist after this batch.
