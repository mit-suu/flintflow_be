---
skill_id: authorization-matrix
kind: content
version: 0.3.0
description: "S-4.3 roles and the screen x role permission matrix, with per-action sub-rows"
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 6144
temperature: 0.3
reads:
  - "roles[]"
  - "actors[]"
  - "screens[]"
  - "permissions[]"
writes:
  - "roles[]"
  - "permissions[]"
  - "assumptions[]"
output_schema: opTransaction
language: en
stub: false
---
# Authorization Matrix

Covers **S-4.3 Screen Authorization** — feeds `fixed:3.1.3`, rendered as a screen × role table. This is
the only place `permissions[]` is written. `references/*.md` are **not loaded at runtime**; the rules are
inlined below.

## Roles

`roles[]` already carries one row per (human actor, distinct permission set) from S-3.1. Add a row only
when the screen inventory reveals a permission set nobody had yet — typically an unauthenticated
`Guest`, or a `Support` role that can read but not write. Shape: `{id, name, actor_id}`. `actor_id` must
point at an existing `actors[]` row with `kind: "human"`, or be `null` for a role that is not tied to one
actor type (`Guest`). System and time actors never get a role — they do not operate the UI.

Do not create a role per screen, and do not split a role because two people *usually* do different work:
two names with the same reachable screens and the same actions are one role.

## Permissions

One `permissions[]` row per **(screen, role, action)** triple that is allowed. Absent row = denied; never
write a row meaning "no access". Shape: `{id, screen_id, role_id, action}` — note the selector for this
collection is the triple (`permissions[screen_id=S3,role_id=R1,action=create]`), so the same triple must
not appear twice.

`action` is one of: `view` (can open the screen and read what is on it), `create`, `update`, `delete`,
`export`, `approve`. Use exactly these words — the rendered table groups by them, and S-5.4 reuses them
when writing per-function validations.

Rules that keep the matrix honest:

1. **`view` is the gate.** A role with `create`/`update`/`delete`/`export`/`approve` on a screen must also
   have `view` on it. Emit both rows.
2. **Every screen needs at least one role with `view`**, including popups and admin screens. A screen no
   role can open is either dead or a missed role.
3. **Every role needs at least one screen.** A role that can reach nothing is an orphan — either it was
   invented here or a screen is missing.
4. **Owner-scoped access is still access.** "The author can only edit their own project" is a `update`
   permission plus a business rule, not a missing row. Note the scoping in an `assumptions[]` entry so
   S-7.1 can turn it into a `business_rules[]` row.
5. **Admin screens.** If an admin actor exists, it gets `view` on every admin screen plus the actions the
   console actually performs (`update` for suspend/reactivate, `approve` where a human decision applies).
   An admin does not automatically get write access to end-user content screens — only if the product
   really allows it.
6. **Unauthenticated screens.** Login, sign-up, forgot password and public landing screens get `view` for
   the `Guest` role (create it if missing). Authenticated screens must NOT have a Guest row.

## Rules

1. Ids continue the existing sequence (`draft-to-ops` rule 5); check the projection first.
2. Every `screen_id`/`role_id` must exist after this batch — a dangling key is `dead_reference`.
3. English values; `action` from the fixed vocabulary above, lowercase.
4. Do not edit `screens[]` or `actors[]` here — if a screen or actor is missing, say so in `notes`
   (Coaching) or add an `assumptions[]` entry naming the gap (Fast); S-4.1/S-3.1 own those collections.
5. Fast mode: pick the least-privilege default that still lets the flow work and record it as an
   assumption; Coaching mode leaves an open question for Elicit (`draft-to-ops` rule 10).

## Example (a guest screen and an owner screen)

```json
{
  "ops": [
    { "op": "add", "path": "roles[]", "value": { "id": "R05", "name": "Guest", "actor_id": "A04" }, "reason": "S-4.3 unauthenticated role" },
    { "op": "add", "path": "permissions[]", "value": { "id": "P01", "screen_id": "S01", "role_id": "R05", "action": "view" }, "reason": "S-4.3 login is public" },
    { "op": "add", "path": "permissions[]", "value": { "id": "P02", "screen_id": "S05", "role_id": "R01", "action": "view" }, "reason": "S-4.3 author opens the workspace" },
    { "op": "add", "path": "permissions[]", "value": { "id": "P03", "screen_id": "S05", "role_id": "R01", "action": "update" }, "reason": "S-4.3 author edits their own project" },
    { "op": "add", "path": "assumptions[]", "value": { "id": "AS12", "path": "permissions[screen_id=S05,role_id=R01,action=update]", "statement": "Update is limited to projects the author owns.", "rationale": "Ownership scoping was not stated in the Brief.", "origin_step_id": "S-4.3", "status": "unconfirmed", "confirmed_at": null }, "reason": "S-4.3 ownership scope" }
  ],
  "notes": "Guest reaches only the public screens; ownership scoping recorded for S-7.1."
}
```

## Self-check

- [ ] Every role has `actor_id` pointing at a `human` actor, or `null` for Guest.
- [ ] Every screen has at least one role with `view`; every role reaches at least one screen.
- [ ] No write/export/approve row without the matching `view` row for the same (screen, role).
- [ ] No duplicate (screen_id, role_id, action) triple.
- [ ] Guest rows appear only on public screens; admin rows only on screens the admin really operates.
- [ ] Ownership/scoping limits recorded as `assumptions[]`, not silently dropped.
