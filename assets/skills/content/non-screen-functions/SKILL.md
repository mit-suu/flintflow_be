---
skill_id: non-screen-functions
kind: content
version: 0.3.0
description: "S-4.4 functions with no screen — cron jobs, webhooks, background engines"
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 6144
temperature: 0.3
reads:
  - "features[]"
  - "functions[]"
  - "use_cases[]"
  - "actors[]"
writes:
  - "functions[]"
  - "use_cases[]"
  - "assumptions[]"
output_schema: opTransaction
language: en
stub: false
---
# Non-Screen Functions

Covers **S-4.4 Non-Screen Functions** — feeds `fixed:3.1.4` and the `function:<id>` sections of the
functions added here. These are the behaviours nobody clicks: they run on a schedule, react to an inbound
call, or process work in the background. They are the part reviewers most often find missing, because the
screen inventory cannot reveal them. `references/*.md` are **not loaded at runtime**; rules are inlined.

## What counts

A non-screen function is a `functions[]` row with `screen_id: null`. It still belongs to a feature
(`feature_id` must exist) and still gets its own `function:<id>` section in §3. It runs in the S-5 loop
under the `@nonscreen` key, after every screen.

Four sources, sweep them in order — for each, either add the function or say in `notes` why it does not
apply:

1. **Scheduled work (`time` actors).** Every `actors[kind=time]` row from S-3.1 must be the initiator of
   at least one function here: expiring reservations, resetting quotas, retrying a failed queue, sending
   a digest, cleaning up stale drafts. If a `time` actor exists with no function, one of the two is wrong.
2. **Inbound calls (`system` actors).** Every `actors[kind=system]` that can call *us* — a payment
   gateway webhook, a mail-delivery callback, an OAuth provider redirect handler. Outbound calls we make
   during a screen action belong to that screen's function, not here.
3. **Background processing.** Work started by a screen but finished out of band: document rendering,
   export generation, AI generation queues, file virus-scanning, search indexing. The trigger is "job
   picked up from the queue", not the button that enqueued it.
4. **Data lifecycle.** Retention/purge, audit-log rotation, soft-delete cleanup, backup verification —
   whenever `project.stakes` is `production` or the domain implies regulated data.

## Shape

`{id, screen_id: null, feature_id, order, name, trigger, description, normal: [], abnormal: [],
validations: [], business_rule_ids: [], priority: null}`.

- `name`: verb + object, same style as screen functions ("Expire Stale Credit Reservations").
- `trigger`: **one sentence naming the event and its cadence or source** — "Every 5 minutes." /
  "Payment gateway POSTs a `payment.succeeded` webhook." / "A render job is dequeued." This field is the
  whole point of the section; leaving it empty makes the function unreviewable.
- `description`: one sentence on what it does and what changes afterwards.
- `order`: continues the feature's numbering, unique within the feature (invariant 5). Non-screen
  functions are rendered after that feature's screen-bound functions.
- `normal`/`abnormal`/`validations` stay empty here — S-5.2/S-5.4 fill them in the `@nonscreen` loop.

## Use case wiring

A non-screen function usually realises a use case a `system` or `time` actor initiates. When the matching
use case already exists, append the new function id to its `function_ids`:
`{ "op": "set", "path": "use_cases[id=UC31].function_ids", "value": ["FN090"] }` — send the **full array**
including ids already there, since `set` replaces it. When no use case covers it, add one
(`{id, name, actor_ids: [<the system/time actor>], function_ids: [<this function>], description,
includes: [], extends: []}`) rather than leaving the function unreachable from §2.

## Rules

1. Ids continue the existing sequence (`draft-to-ops` rule 5); check the projection first.
2. `feature_id` and every id in `actor_ids`/`function_ids` must exist after this batch.
3. Never set `screen_id` to a screen here — that is what makes it a non-screen function.
4. Do not add screens, roles or permissions; those collections belong to S-4.1/S-4.3.
5. English values, no diacritics, no section numbers in prose (`draft-to-ops` rules 6–7).
6. Fast mode: add the function with the most reasonable cadence plus an `assumptions[]` entry
   (`status: "unconfirmed"`); Coaching mode leaves it for Elicit (`draft-to-ops` rule 10).

## Example (a scheduled job and its use case)

```json
{
  "ops": [
    { "op": "add", "path": "functions[]", "value": { "id": "FN090", "screen_id": null, "feature_id": "F6", "order": 4, "name": "Expire Stale Credit Reservations", "trigger": "Every 5 minutes, for reservations older than their expires_at.", "description": "Releases credits held by AI calls that never completed so the wallet balance is accurate.", "normal": [], "abnormal": [], "validations": [], "business_rule_ids": [], "priority": null }, "reason": "S-4.4 scheduled job for the time actor" },
    { "op": "set", "path": "use_cases[id=UC31].function_ids", "value": ["FN090"], "reason": "S-4.4 wire the job to its use case" }
  ],
  "notes": "Webhook handler already existed as FN088; no data-retention job — stakes is internal."
}
```

## Self-check

- [ ] Every `actors[kind=time]` initiates at least one function here, or `notes` says why not.
- [ ] Every inbound integration from a `system` actor has a handler function.
- [ ] Background/queue work started by a screen has its own function with a job-level `trigger`.
- [ ] Every function has `screen_id: null`, a real `feature_id`, and `order` unique in that feature.
- [ ] `trigger` names an event and a cadence/source; `description` says what changes.
- [ ] Each function appears in exactly one use case's `function_ids` (existing or newly added).
