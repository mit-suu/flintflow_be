# Use case naming — S-3.2

## Shape

`name` = **verb + object**, present tense, no actor name inside it: "Draft Product Brief", not "Founder
Drafts Brief" or "Brief Drafting". Title Case, no trailing punctuation.

## Granularity

One use case = one goal accomplished in one sitting, independent of UI screens. "Accept Step At Gate" is
one use case even if the gate has four buttons (accept/revision/regenerate/accept_as_is act on the same
goal from different angles — model the variants as `extends`, not separate use cases, unless the audit
finds a genuinely distinct goal).

Too coarse: "Manage Project" (bundles create, edit, delete, export — split them).
Too fine: "Click Accept Button" (implementation detail, not a goal — belongs in a function's normal flow,
not here).

## Required fields at creation

```text
{ id, name, actor_ids: [at least one existing actor id], function_ids: [],
  description: "<actor>, trigger, outcome — one sentence>",
  includes: [], extends: [] }
```

`function_ids` is always `[]` here — functions are assigned at S-4.4 (`use_cases[].function_ids`), not by
this skill. Leaving it empty is correct, not incomplete.

## `actor_ids`

List every actor that **participates** in this use case — an association in UML terms — with the primary
actor first. Participation is wider than initiation: an actor the flow calls out to belongs here too, and
a `system` actor can be the primary actor. Do not restrict `actor_ids` to `human` only, and do not invent
a use case for a `system`/`time` actor only so that it has one.

A use case that has `extends[]`, or that another use case includes, is **not drawn connected to an
actor** — the actor reaches it through the base. Keep `actor_ids` accurate anyway; the renderer decides
what to draw.

## description at creation vs S-3.5

Write a complete one-sentence description when the use case is created (S-3.2/S-3.3) — do not leave it
empty for S-3.5 to fill later; the schema requires a non-empty string on every `use_cases[]` element from
the moment it is added. S-3.5's job is to *finalize/tighten* wording across the whole list for consistency
of tense and voice, not to fill in blanks left behind.

## Naming rules

U1–U6, U8, A2 and A7 are checked deterministically (`usecase_name_style`, `usecase_name_semantic`,
`actor_name_shape` in `deterministic-check.ts`) — a breach raises a yellow flag whatever the prompt said.
The rest need judgement and live in `SKILL.md`.

| # | Rule | Checked by |
| --- | --- | --- |
| U1 | Title Case, no trailing period; a minor word (`at`, `of`, `the`…) may stay lower case when it is not first | code |
| U2 | One goal only — no ` and `, `/` or `,` joining two goals | code |
| U3 | No vague verb (`Manage`, `Handle`, `Process`, `Maintain`…) as the first word | code |
| U4 | No actor name inside the use case name | code |
| U5 | No UI or technical term (`Button`, `Screen`, `Page`, `API`…) | code |
| U6 | At most 5 words | code |
| U7 | The object uses the business term from the Brief/Glossary, consistently | prompt |
| U8 | No duplicate use case name | code |
| U9 | The name shows the value the actor gets ("Update Record" ⇒ "Approve Purchase Order") | prompt |
| A1 | Singular role/party noun phrase, Title Case — never a person's name or a team | prompt |
| A2 | Not a bare `User`/`System`/`Actor`/`Person` (a qualified name such as "Registered User" is fine) | code |
| A3 | Not named after a screen or a feature | prompt |
| A4 | A `system` actor is the outside role, not the vendor or version | prompt |
| A5 | A `time` actor is named after what it triggers | prompt |
| A6 | Two names sharing every capability are one actor with two `roles[]` rows | prompt |
| A7 | No duplicate actor name | code |
| A8 | `description` answers the three FPT §2.1 questions in one product-specific sentence | prompt |
