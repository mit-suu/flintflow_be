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

List every actor who can *initiate* this use case, not every actor who is merely affected by it. A
`system` actor can be the primary actor of a use case ("Process Credit Purchase" initiated by the payment
gateway callback) — do not restrict `actor_ids` to `human` only.

## description at creation vs S-3.5

Write a complete one-sentence description when the use case is created (S-3.2/S-3.3) — do not leave it
empty for S-3.5 to fill later; the schema requires a non-empty string on every `use_cases[]` element from
the moment it is added. S-3.5's job is to *finalize/tighten* wording across the whole list for consistency
of tense and voice, not to fill in blanks left behind.
