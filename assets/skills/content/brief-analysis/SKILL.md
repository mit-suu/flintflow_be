---
skill_id: brief-analysis
kind: content
version: 0.2.0
description: "S-1.1 Brief Extraction, S-1.3 Conflict & Assumption Review, S-1.4 Gap List"
provider: anthropic
aiModel: claude-haiku-5-5
maxTokens: 6144
temperature: 0.3
reads:
  - "project"
  - "addendum[]"
  - "assumptions[]"
  - "other_requirements[]"
writes:
  - "project"
  - "addendum[]"
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
`project{}` + `addendum[]` by B-0…B-2, and this phase makes that material **usable** - complete enough,
consistent enough, and honest about what is still missing. It writes **no SRS section**; S-2 is the first
step that does.

`references/*.md` are not loaded at runtime; the rules are here.

## S-1.1 - Brief Extraction

The Brief keeps vision and goals in the user's language as addendum entries (`topic: "vision"` - one entry;
`topic: "goals"` - one entry per goal), each with `content_en`. B-* never writes `project.vision`/`project.goals`;
**this step builds them, in English, for SRS §1.**

- **Always** `set project.vision` when a `vision` entry exists (one English sentence: who, what changes, why it matters -
  from its `content_en`), and `set project.goals` when `goals` entries exist (the full array, 1:1 with the `goals`
  entries in addendum order, from each `content_en`) - even when the fields already have values. No entry ⇒ do not
  write that field. Never merge two goals, never invent a goal no entry supports. Any batch that sets `project.goals`
  (also a revision) must have exactly one item per `goals` entry; the server rejects a mismatch.
- No such addenda (older project, imported brief): fill `project.vision`/`goals[]` only when empty or clearly weaker
  than the other addenda say; do not invent.
- `project.form_factor`, `stakes` are set at B-0; only touch one if an addendum
  contradicts it outright, and then add an `assumptions[]` entry explaining the override.
- **Revision at this gate:** the user changes the *meaning* (drop/add/reword a goal) ⇒ edit the `vision`/`goals`
  addendum entry (`content` in the user's language + `content_en`; `add`/`remove` a `goals` entry) **and** rebuild
  both EN fields in the same batch. Only the English wording changes ⇒ edit just the EN fields.
- `notes` (the message the user reads at the gate) is in the user's language, plain and warm: say what you turned
  into the SRS vision and goals, no field names.
- Other `addendum[]` entries are not yours: extraction reads them, triage happened at B-2.2.

Nothing to extract is a valid outcome: return `ops: []` and say so in `notes`.

## S-1.3 - Conflict & Assumption Review

Two jobs, both about honesty rather than volume.

**Conflicts.** Two addenda that cannot both be true ("mobile first" vs "desktop dashboard for analysts"),
an addendum that contradicts `project.goals[]`, or a metric that contradicts the stated scope. For each
one: open an `other_requirements[kind=open_question]` stating **both sides and what depends on the
answer** - never pick a winner silently. A conflict the user has to discover at S-4 costs a whole phase.

**Assumptions.** Sweep `assumptions[status=unconfirmed]` again, but only the ones whose truth changes
what the document will say. Present those; leave the rest for S-9.1's sweep. Do not mass-confirm:
`status` moves to `confirmed` only on the user's word, and `confirmed_at` is set at the same time.

## S-1.4 - Gap List

What the SRS will need and the Brief does not have yet. Write each as
`other_requirements[kind=open_question]` - one per gap, phrased as the question a reviewer would ask; `statement` English, `statement_vi` in the user's language.

**Every gap carries `source_quote`**: the sentence that **raises the need**, copied verbatim (one or two sentences, no
paragraph code) from the Brief - an addendum entry's `content` or `content_en`, a `project` field - or from an uploaded
document. The quote is not about what is missing; it is what makes the gap matter: "khách thanh toán online" ⇒ gap
"Which payment gateway is used, and what happens when a payment fails?" with `source_quote: "khách thanh toán online"`.
No sentence raises the need ⇒ do not write the gap. The server drops every gap whose quote is missing or not found word
for word in the Brief or the documents.

Sweep these themes; keep a gap only when a quoted sentence raises it, and say in `notes` which themes nothing in the
Brief raises:

1. **Who else uses it** - an admin, a support role, an approver; almost every product has a second human
   actor the Brief forgot.
2. **What it talks to** - payment, mail, identity, storage, an AI provider; these become `system` actors
   at S-3.1 and interface NFRs at S-6.1.
3. **What runs on a schedule** - expiry, retry, digest, cleanup; these become the `@nonscreen` round.
4. **What must not happen** - the destructive or money-moving action that needs a rule.
5. **Numbers** - any "fast", "reliable", "secure" with no figure behind it (S-6.3/S-6.4 will need one).
6. **Data that outlives a session** - what is stored, and for how long.

A gap list is not a complaint list: each entry should be answerable in one sentence by the user. Fewer grounded gaps
beat a full sweep of generic ones.

<!-- ba-quality:shared:start -->
**Analysis quality** - applies to every finding, gap, proposed change, recommendation and reason you write (not to the plain answer options of a question):
- **(a) Quote it or drop it.** Each one rests on words you can copy verbatim from the uploaded documents, the Brief, the current SRS content or the user's messages. Where the output has a quote or source field, put that exact text there. Nothing to quote ⇒ do not raise it.
- **(b) Never ask what is already answered** - in the documents, the Brief, the SRS content, a settled decision or an earlier answer.
- **(c) Recommend only when you are sure**: a clear basis in the documents, the Brief, the SRS content or a settled decision. A recommendation always states its reason and that basis. Not sure ⇒ give the options side by side, with no recommendation.
- **(d) Specific to this project, never generic advice**: name the screen, role, data or rule it is about.
  - Fails: "nên cân nhắc bảo mật" (consider security).
  - Passes: "màn đối soát hiện số tiền, nên chỉ cho vai Kế toán xem" (the reconciliation screen shows amounts, so only the Accountant role should see it).
<!-- ba-quality:shared:end -->
## Rules

1. Ids continue the existing sequence (`draft-to-ops` rule 5) - check the projection first.
2. Write only `project`, `other_requirements[]`, `assumptions[]`. No `actors[]`, `use_cases[]`,
   `screens[]`, `functions[]`, `sections[]`; `addendum[]` only for the S-1.1 revision on `vision`/`goals` entries.
3. `project.goals[]` is sent as the **full array** (`set` replaces it) - include the goals already there.
4. English values, no diacritics, no section numbers in prose (`draft-to-ops` rules 6–7).
5. Still unclear: record the most reasonable reading plus an `assumptions[]` entry (`draft-to-ops`
   rule 10).

## Example (S-1.1)

```json
{
  "ops": [
    { "op": "set", "path": "project.vision", "value": "Patients book clinic visits online so they skip the phone queue and reception staff handle fewer calls.", "reason": "S-1.1 dựng tầm nhìn tiếng Anh từ Brief" },
    { "op": "set", "path": "project.goals", "value": ["Cut the average time to book a visit to under two minutes", "Reduce reception phone calls by half within six months"], "reason": "S-1.1 dựng mục tiêu tiếng Anh, khớp từng mục của Brief" }
  ],
  "notes": "Mình đã chuyển tầm nhìn và 2 mục tiêu của bạn sang tiếng Anh để đưa vào tài liệu. Bạn xem bảng bên cạnh, cần chỉnh ý nào thì nhắn mình nhé."
}
```

## Example (S-1.4)

```json
{
  "ops": [
    { "op": "add", "path": "other_requirements[]", "value": { "id": "OR07", "kind": "open_question", "statement": "Who reviews and suspends patient accounts once the product is live, and what can that role see?", "source_quote": "Patients book clinic visits online" }, "reason": "S-1.4 gap: no second human actor named" },
    { "op": "add", "path": "other_requirements[]", "value": { "id": "OR08", "kind": "open_question", "statement": "How many seconds may the booking page take to respond at the busiest hour?", "source_quote": "Cut the average time to book a visit to under two minutes" }, "reason": "S-1.4 gap: no response time behind the booking goal" },
    { "op": "add", "path": "assumptions[]", "value": { "id": "AS09", "path": "project.goals", "statement": "Reliable means the service is available during business hours, not 24/7.", "rationale": "The Brief says reliable with no window.", "origin_step_id": "S-1.4", "status": "unconfirmed", "confirmed_at": null }, "reason": "S-1.4 quantified a vague word" }
  ],
  "notes": "Nothing in the Brief raises scheduled work; data retention already answered in B-1.6."
}
```

## Self-check

- [ ] S-1.1 rebuilt `project.vision` + `goals[]` (English) 1:1 from the `vision`/`goals` addenda.
- [ ] `addendum[]` untouched except S-1.1 revision on `vision`/`goals`; no SRS collection written.
- [ ] Every conflict is an `open_question` naming both sides - none silently resolved.
- [ ] Assumptions only moved to `confirmed` on the user's word, with `confirmed_at`.
- [ ] Every gap has a `source_quote` copied verbatim from the Brief or a document; a theme nothing raises is named in `notes`, never invented.
- [ ] Every gap is answerable in one sentence.
