---
skill_id: brief-analysis
kind: content
version: 0.1.0
description: "S-1.1 Brief Extraction, S-1.3 Conflict & Assumption Review, S-1.4 Gap List"
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 6144
temperature: 0.3
reads:
  - "project"
  - "addendum[]"
  - "assumptions[]"
  - "other_requirements[]"
writes:
  - "project"
  - "other_requirements[]"
  - "assumptions[]"
output_schema: opTransaction
language: en
stub: false
---
# Brief Analysis

Covers **S-1.1 Brief Extraction · S-1.3 Conflict & Assumption Review · S-1.4 Gap List**.
(S-1.2 Project Classification is a different skill, `project-classifier`.)

S-1 is the hinge between a conversation and a document: the Brief has already been captured as
`project{}` + `addendum[]` by B-0…B-2, and this phase makes that material **usable** — complete enough,
consistent enough, and honest about what is still missing. It writes **no SRS section**; S-2 is the first
step that does.

`references/*.md` are not loaded at runtime; the rules are here.

## S-1.1 — Brief Extraction

Read every `addendum[]` entry and ask one question of each: *is the structured field it implies actually
filled in?* The Brief may have captured a vision in prose but left `project.vision` empty, or named five
outcomes in an addendum while `project.goals[]` has two.

- Fill `project.vision` (one sentence: who, what changes, why it matters) when it is empty or clearly
  weaker than what the addenda say.
- Fill or extend `project.goals[]` to 3–6 outcome-shaped goals drawn from the addenda — outcomes, not
  features. Do not invent a goal no addendum supports.
- `project.form_factor`, `stakes`, `working_mode` are set at B-0; only touch one if an addendum
  contradicts it outright, and then add an `assumptions[]` entry explaining the override.
- **Do not rewrite or delete `addendum[]`.** Extraction reads from it; triage already happened at B-2.2.

Nothing to extract is a valid outcome: return `ops: []` and say so in `notes`.

## S-1.3 — Conflict & Assumption Review

Two jobs, both about honesty rather than volume.

**Conflicts.** Two addenda that cannot both be true ("mobile first" vs "desktop dashboard for analysts"),
an addendum that contradicts `project.goals[]`, or a metric that contradicts the stated scope. For each
one: open an `other_requirements[kind=open_question]` stating **both sides and what depends on the
answer** — never pick a winner silently. A conflict the user has to discover at S-4 costs a whole phase.

**Assumptions.** Sweep `assumptions[status=unconfirmed]` again, but only the ones whose truth changes
what the document will say. Present those; leave the rest for S-9.1's sweep. Do not mass-confirm:
`status` moves to `confirmed` only on the user's word, and `confirmed_at` is set at the same time.

## S-1.4 — Gap List

What the SRS will need and the Brief does not have yet. Write each as
`other_requirements[kind=open_question]` — one per gap, phrased as the question a reviewer would ask.

Sweep these, and say in `notes` when one genuinely does not apply:

1. **Who else uses it** — an admin, a support role, an approver; almost every product has a second human
   actor the Brief forgot.
2. **What it talks to** — payment, mail, identity, storage, an AI provider; these become `system` actors
   at S-3.1 and interface NFRs at S-6.1.
3. **What runs on a schedule** — expiry, retry, digest, cleanup; these become the `@nonscreen` round.
4. **What must not happen** — the destructive or money-moving action that needs a rule.
5. **Numbers** — any "fast", "reliable", "secure" with no figure behind it (S-6.3/S-6.4 will need one).
6. **Data that outlives a session** — what is stored, and for how long.

A gap list is not a complaint list: each entry should be answerable in one sentence by the user.

## Rules

1. Ids continue the existing sequence (`draft-to-ops` rule 5) — check the projection first.
2. Write only `project`, `other_requirements[]`, `assumptions[]`. No `actors[]`, `use_cases[]`,
   `screens[]`, `functions[]`, `sections[]`, and no edits to `addendum[]`.
3. `project.goals[]` is sent as the **full array** (`set` replaces it) — include the goals already there.
4. English values, no diacritics, no section numbers in prose (`draft-to-ops` rules 6–7).
5. Fast mode: record the most reasonable reading plus an `assumptions[]` entry; Coaching mode leaves the
   open question for Elicit (`draft-to-ops` rule 10).

## Example (S-1.4)

```json
{
  "ops": [
    { "op": "add", "path": "other_requirements[]", "value": { "id": "OR07", "kind": "open_question", "statement": "Who reviews and suspends accounts once the product is live, and what can that role see?" }, "reason": "S-1.4 gap: no second human actor named" },
    { "op": "add", "path": "other_requirements[]", "value": { "id": "OR08", "kind": "open_question", "statement": "What response time counts as fast for a generation step, in seconds?" }, "reason": "S-1.4 gap: no number behind fast" },
    { "op": "add", "path": "assumptions[]", "value": { "id": "AS09", "path": "project.goals", "statement": "Reliable means the service is available during business hours, not 24/7.", "rationale": "The Brief says reliable with no window.", "origin_step_id": "S-1.4", "status": "unconfirmed", "confirmed_at": null }, "reason": "S-1.4 quantified a vague word" }
  ],
  "notes": "No scheduled work implied by the Brief; data retention already answered in B-1.6."
}
```

## Self-check

- [ ] `project.vision` and 3–6 outcome-shaped `goals[]` are filled and supported by addenda.
- [ ] `addendum[]` untouched; no SRS collection written.
- [ ] Every conflict is an `open_question` naming both sides — none silently resolved.
- [ ] Assumptions only moved to `confirmed` on the user's word, with `confirmed_at`.
- [ ] The six gap themes are covered or explained in `notes`.
- [ ] Every gap is answerable in one sentence.
