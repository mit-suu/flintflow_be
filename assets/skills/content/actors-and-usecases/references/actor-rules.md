# Actor rules — S-3.1

## Kinds

| `kind` | Meaning | Gets a `roles[]` row? |
| --- | --- | --- |
| `human` | A person who operates the product through a UI | Yes, unless it shares a role with another actor |
| `system` | An external system the product integrates with (already partly seeded at S-2.3) | No |
| `time` | A scheduler/cron/trigger with no UI (nightly job, expiry sweep) | No |

## What makes an actor, not a role name

An actor is a *type of party*, not a job title synonym. "Admin" and "Support Agent" are two actors only
if they act on the product differently (different goals, different use cases); if they share every
capability, model one actor with two `roles[]` rows instead.

## Minimum set for a guided-pipeline-style product

Even a small brief usually has at least: the primary human actor (the one running the workflow), one
back-office/admin human actor, one external system actor (payment, render, auth…), and — if the product
has any scheduled behavior (credit expiry, digest email, cleanup) — one `time` actor. Missing any of these
without a stated reason is a signal to re-check the Brief, not to skip it.

## Roles

- One `roles[]` row per (actor, distinct permission set). A single actor with one uniform capability set
  needs exactly one role.
- `actor_id` must be a `human` actor's id — never a `system`/`time` actor, never `null` at creation. A role
  can outlive its actor (`op-grammar.md` cascade: removing an actor sets `roles[actor_id=A].actor_id →
  null`), but a *new* role must always point somewhere.
- Do not create a role before its actor exists in the same batch — order `add actors[]` before the
  matching `add roles[]` (both may be in the same transaction; the engine resolves within-batch adds).

## Naming

- Actor name: a noun phrase describing the party, not a screen name — "Founder / Business Analyst", not
  "Dashboard User".
- Description: one sentence, what this actor does *for this product*, not a generic dictionary
  definition. "Internal support staff who handles escalated user tickets", not "A person who helps
  customers".
