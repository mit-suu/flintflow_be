<!-- Source: Phases §6.4 (S-8.4, S-9.2, S-9.3), srs-spine.md §8.2; pattern from BMAD `bmad-review/references/lens-*.md`. Loaded into the review-section prompt (prompt_references). -->
# Review lenses

All lenses output **yellow** flags. Apply only the lenses listed in *Lenses to apply*; each flag quotes the phrase or names the element it is about.

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

## `requirement_conflict` (S-9.2)

Any two requirements (function, business rule, validation, NFR, use case) that say opposite things.

- Pass: BR03 "free cancellation up to 4 hours before" vs function Cancel Booking "up to 24 hours before". Quote one side, name the other.
- Fail: two rules on different subjects, or a difference that is only wording.

## `decision_conflict` (S-9.2)

Content contradicts a settled decision (still valid, not superseded).

- Pass: decision "expired profiles are anonymised, not deleted" vs a business rule "profile is deleted automatically after 4 years". Quote the rule sentence; name the decision by its topic.
- Fail: content merely says less than the decision, or the decision was replaced.

## `assumption_conflict` (S-9.2)

Two assumptions that disagree, or an assumption against the content or a decision.

- Pass: "used on desktop and tablet only" vs "customers use their phones". Quote the statement.
- Fail: a rejected assumption, or two assumptions about different things.

## `source_conflict` (S-9.2)

The SRS says something different from an uploaded document (minutes, notes, original spec). Skip this lens when no document is given.

- Pass: the minutes list 3 roles, the SRS actors list only 2. Quote the SRS side.
- Fail: the document is silent on the point.

## `cross_section_gap` (S-8.4)

An element is mentioned in one section but the section that must list it does not, or a sentence states a count different from the real one.

- Pass: NFRs mention an email service and backups, but External Interfaces and the system actors list neither; or prose says "seven feature groups" while only 6 exist.
- Fail: an element that is correctly absent from that section.

## `semantic_duplicate` (S-8.4 only)

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

## Three-Lens Review (B-2.3) - not this skill

Skeptic / Opportunity / Contextual are FlintFlow's own Brief lenses and live in `content/product-brief`.
