---
skill_id: product-brief
kind: content
version: 0.2.0
description: "B-0 Intake, B-1 Product Brief, B-2 Brief Finalize — adapted from BMAD bmad-product-brief"
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
  - "addendum[]"
  - "assumptions[]"
  - "other_requirements[]"
output_schema: opTransaction
language: user
stub: false
---
# Product Brief

Covers the whole Brief phase: **B-0.1…B-0.4 intake · B-1.1…B-1.6 the brief itself · B-2.1…B-2.3
finalize**. The Brief writes **no SRS section**; it fills `project{}` and stores everything else as
`addendum[]` aimed at the section it will later feed. S-1 turns that into structure; S-2 onward writes
the document.

Two habits decide whether this phase is useful:

- **Write as you go.** Every step ends with ops. A fact that stays in the chat transcript is lost — the
  transcript is not read by later steps, only the Spine is.
- **Record the unknown, do not invent it.** Anything the user has not said becomes an `assumptions[]`
  entry (`status: "unconfirmed"`) or an `other_requirements[kind=open_question]`, never a confident
  sentence in `project.vision`.

`references/*.md` are **not loaded at runtime** — the rules below are what you get.

## B-0 — Intake (4 steps)

- **B-0.1 Brain Dump.** The user talks freely, and uploaded documents (if any) arrive in the content
  guidance. Extract, then read back a short summary for confirmation. Write **one `addendum[]` entry per
  distinct topic** right now — `{id, topic, content (user's own words/language), content_en (English,
  for rendering), target_section, captured_at}`. Do not wait for a tidy answer before writing.
- **B-0.2 `project.form_factor`** — where the product lives: `web_app`, `mobile_app`, `desktop_app`,
  `api_service`, `cli`, `embedded`. Ask once; infer from the brain dump when it is obvious.
- **B-0.3 `project.stakes`** — `internal` | `production` | `regulated`. This drives NFR defaults at S-6,
  so a guess here must come with an `assumptions[]` entry.
- **B-0.4 `project.working_mode`** — `coaching` (gate every step, ask freely) or `fast` (at most two
  question turns per phase, fill gaps with assumptions). Explain the trade-off in one sentence and let
  the user choose; do not choose silently.

## B-1 — The brief (6 steps)

Each step: ask what is missing, then write. `project.vision` and `project.goals[]` are the only
`project` fields B-1 writes; everything else is an addendum aimed at a section.

| Step | Writes | `target_section` |
| --- | --- | --- |
| B-1.1 Vision, problem, opportunity | `project.vision`, `project.goals[]` (3–6, outcome-shaped), addendum for the problem/why-now | `fixed:1` |
| B-1.2 Target users & jobs-to-be-done | addendum per persona/stakeholder, with the job each one needs done | `fixed:2.1` |
| B-1.3 Value proposition & differentiation | addendum: what makes this worth using over the current way | `fixed:1` |
| B-1.4 MVP scope & feature hypotheses | addendum per capability, and the explicit not-now list | `fixed:1`, `fixed:3.1.2` |
| B-1.5 Success metrics & learning goals | addendum per metric, with a number where the user gave one | `fixed:4.2.2`, `fixed:4.2.3` |
| B-1.6 Risks, assumptions, open questions | `other_requirements[]` (`kind` = `risk` / `assumption` / `open_question`) **and** `assumptions[]` for anything you filled in yourself | `fixed:5.4` |

`project.goals[]` are outcomes, not features: "cut the time to a first usable SRS from weeks to a day",
not "add an export button". 3–6 of them; more than that and none of them is a goal.

## B-2 — Finalize (3 steps)

- **B-2.1 Assumption Sweep.** Present every `assumptions[status=unconfirmed]` gathered so far. The user
  confirms or rejects, one by one or the whole batch. Write `status` + `confirmed_at`; a rejected
  assumption means the underlying value is wrong — say what needs to change rather than leaving it.
- **B-2.2 Addendum Triage.** Go through `addendum[]`: **keep** (fix `target_section` if it is aimed at the
  wrong place), **park** (true but not this release — retarget it to `fixed:5.4` so S-7.4 picks it up as
  an Other Requirement), or **drop** (only when the content is *wrong*, never when it is merely deferred).
  This step may write `addendum[]` and `assumptions[]` only — parking is a retarget, not a move into
  `other_requirements[]`. Last cheap moment to fix a wrong `target_section`.
- **B-2.3 Three-Lens Review.** Read the brief back through three lenses, one short paragraph each:
  **Skeptic** (what would make this fail, what is asserted without evidence), **Opportunity** (what the
  brief is under-claiming, what adjacent value is one step away), **Contextual** (what the domain,
  `stakes` and `form_factor` imply that nobody said out loud). Anything the lenses surface becomes an
  `other_requirements[]` or an `assumptions[]` entry — a lens finding with no op is a lens finding that
  never happened. Then hand over: accepting this gate opens S-1.

## Rules

1. Ids continue the existing sequence (`draft-to-ops` rule 5) — check the projection first.
2. `addendum[].target_section` must be a real section key (`fixed:*`, or `feature:<id>` / `function:<id>`
   once those exist). Unsure ⇒ `fixed:5.4`, and say so in `notes`.
3. `content` keeps the user's own words and language; `content_en` is the English version that will be
   rendered. Both are required, never empty.
4. Never write `actors[]`, `use_cases[]`, `screens[]`, `functions[]` or any section here — the Brief is
   input to the SRS, not the SRS. Those come from S-2 onward.
5. Fast mode: at most two question turns per phase, then fill the rest with the most reasonable reading
   plus `assumptions[]` entries. Coaching mode: ask until the step is genuinely answered.
6. `reply` to the user is in **their language**; `content_en` and anything destined for the document is
   English (`draft-to-ops` rules 6–7).

## Example (B-1.1)

```json
{
  "ops": [
    { "op": "set", "path": "project.vision", "value": "Let a solo founder turn a raw product idea into a complete, internally consistent SRS through a guided conversation.", "reason": "B-1.1 vision" },
    { "op": "set", "path": "project.goals", "value": ["Cut time to a baseline-quality SRS from weeks to one day", "Keep every section traceable to a stated business goal", "Make the cost of one document predictable"], "reason": "B-1.1 goals" },
    { "op": "add", "path": "addendum[]", "value": { "id": "AD11", "topic": "Why now", "content": "Đội nhỏ không thuê được BA, tài liệu viết tay lệch nhau giữa các phần.", "content_en": "Small teams cannot hire a requirements engineer, and hand-written documents drift between sections.", "target_section": "fixed:1", "captured_at": "2026-09-16T00:00:00.000Z" }, "reason": "B-1.1 problem statement" },
    { "op": "add", "path": "assumptions[]", "value": { "id": "AS01", "path": "project.goals", "statement": "One day means one working day for one person.", "rationale": "The user said fast but gave no number.", "origin_step_id": "B-1.1", "status": "unconfirmed", "confirmed_at": null }, "reason": "B-1.1 quantified a vague goal" }
  ],
  "notes": "Vision and three goals written; the why-now went to fixed:1."
}
```

## Self-check

- [ ] Every step ended with at least one op — nothing important left only in the chat.
- [ ] `project.form_factor`, `stakes`, `working_mode` all set by the end of B-0.
- [ ] `project.vision` + 3–6 outcome-shaped `goals[]` by the end of B-1.1.
- [ ] Every addendum has `content`, `content_en` and a real `target_section`.
- [ ] Everything you filled in yourself has an `assumptions[]` entry, not a confident sentence.
- [ ] B-2.1 left no `unconfirmed` assumption unasked; B-2.2 left no addendum untriaged, and parked ones
      point at `fixed:5.4`.
- [ ] B-2.3 produced ops, not just three paragraphs.
- [ ] No `actors[]`, `use_cases[]`, `screens[]`, `functions[]` or `sections[]` written anywhere.
