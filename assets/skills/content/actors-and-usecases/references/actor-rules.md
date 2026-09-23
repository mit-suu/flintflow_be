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

## Access (every human actor)

Decide how each human actor gets into the product and say it in its `description`:

- `self-registers` — creates its own account.
- `invited` — its account is created or invited by another actor (who then needs a "Create/Invite … Account"
  use case).
- `identity provider` — sign-in is delegated; the provider is a `system` actor.
- `no sign-in` — uses the product publicly, as a guest.

When the Brief/addendum does not say, pick the likeliest option and write **one** `assumptions[]` entry
(`path: "actors[]"`) listing every unresolved actor — one combined question the user confirms at the gate,
never one question per actor. S-3.2 derives Log In / Register / Reset Password from this result.

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
