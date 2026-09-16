# Review lenses — source: Phases §6.4 (S-8.4, S-9.2, S-9.3), srs-spine.md §8.2; pattern from BMAD `bmad-review/references/lens-*.md`

All lenses output **yellow** flags. Round one ships the schema; LLM yellow flags are cut from the round-one scope (Phases §9.1) except where a step explicitly enables a lens.

## `ambiguity`

Wording a tester could not verify.

- Weasel words: *fast, user-friendly, reasonable, secure, flexible, etc., and so on, as needed, if possible*.
- Unbounded quantities: "many", "large files", "a lot of users".
- Passive voice hiding the actor: "the request is approved" (by whom?).
- Flag: quote the phrase, suggest the measurable form.

## `fr_nfr_conflict`

A function contradicts an NFR.

- `functions[].normal[]` sends an email synchronously while `nfrs[category=performance]` requires < 1 s response.
- Export of 10,000 rows on a screen while performance NFR caps payload.
- Offline requirement vs a function that needs a live external system.
- Flag on the **function** section; mention the NFR id in the message.

## `security_risk`

- A screen with create/update/delete actions and no `permissions[]` row restricting it.
- Personal or payment data handled with no NFR in `nfrs[category=other]` about protection.
- Password / token shown or exported in plain text.
- Admin function reachable by a non-admin role.

## `semantic_duplicate` (S-8.4)

- Two use cases with different names and the same actor + goal.
- Two business rules stating the same constraint.
- Two messages with the same text and different codes.
- Flag the later element; reference the earlier id.

## `term_drift` (S-8.4)

Keyed names change in one place, but prose does not follow (Phases §2.3 limit).

- `actors[id=A03].name = "Administrator"` while descriptions still say "Admin".
- Glossary term "Workspace" vs prose "Project Space".
- Flag the element whose prose drifts; say which canonical name to use.

## `goal_coverage` (S-9.3)

- Each `project.goals[]` entry must be served by at least one function or NFR.
- Flag `fixed:1` with the uncovered goal quoted.

## Three-Lens Review (B-2.3) — not this skill

Skeptic / Opportunity / Contextual are FlintFlow's own Brief lenses and live in `content/product-brief`.
