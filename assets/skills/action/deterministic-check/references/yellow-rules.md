# Yellow flags — source: srs-spine.md §8.1 (cardinality) + use case relations and naming

Deterministic, non-blocking, each with a `rule_id`.

| `rule_id` | Condition | `remediation_step` |
| --- | --- | --- |
| `orphan_actor` | An actor of any kind (human, system, time) is in no `use_cases[].actor_ids[]` — the diagram only declares actors that have an edge, so it would vanish silently | S-3.2 |
| `usecase_no_function` | `use_cases[].function_ids[]` empty | S-3.2 |
| `screen_no_function` | A screen has no function | S-4.1 |
| `orphan_screen` | A screen no human actor uses (once any screen ↔ actor link exists), or, once any `flow_to` edge exists, a screen with no incoming and no outgoing edge, or a pop-up nothing opens | S-4.2 |
| `empty_feature` | A feature has neither screen nor function | S-4.1 |
| `role_no_actor` | `roles[].actor_id` is null | S-3.1 |
| `non_english_content` | A field in the **Owns** column contains Vietnamese diacritics | owner step of the field |
| `usecase_floating` | A use case has no actor, no `extends[]`, and is included by nobody | S-3.2 |
| `usecase_auth_relation` | An authentication / account-access use case (Log In, Sign In, Register, Reset Password, Recover Account… and their Vietnamese forms, matched as whole phrases) is included by another use case, or itself extends one | S-3.4 |
| `usecase_name_semantic` | Use case name breaks U2 (two goals joined), U3 (vague verb such as Manage/Handle), or U8 (duplicate name) | S-3.2 |
| `usecase_name_style` | Use case name breaks U1 (Title Case, no trailing period), U4 (repeats an actor name), U5 (UI or technical term), or U6 (more than 5 words) | S-3.2 |
| `actor_name_shape` | Actor name breaks A2 (bare `User`/`System`/`Actor`/`Person`) or A7 (duplicate name) | S-3.1 |
| `system_name_missing` | A context or use case diagram exists but `project.system_name` is empty, so the diagrams and cover print the working project name (excluded in mode 1) | B-0.1 |

Cardinality is **yellow, not red**: as red, every `placeholder` screen of round one would hit `screen_no_function` and need mass waivers.

## `non_english_content`

- Scan only fields that render into the SRS (Owns column of srs-spine §4).
- Skip `addendum[].content` (verbatim user text), `glossary[].term_native`, `changes[].reason`, `flags[].message`, `waive_reason` — those follow the user's language by design (Phases §1.3).
- Detection: any character in the Vietnamese diacritic ranges (e.g. `/[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i`).
- `target_id` = element id; `message` names the field path.

## Use case naming

`usecase_name_semantic` and `usecase_name_style` are two `rule_id`s on purpose. Semantic breaches are modelling errors in any language; style breaches ride on English spelling, so mode 1 (imported SRS) excludes `usecase_name_style` and keeps `usecase_name_semantic`. U1 accepts a minor word (`at`, `of`, `the`…) capitalised or not when it is not the first word, so `Accept Step At Gate` passes. A2 matches the whole name, not a substring, so `Registered User` passes.

## Account-access relations

Authentication is a **precondition** of a protected use case (a state the actor is in), not a step re-run every time, so it is never an `<<include>>` target; Register / Reset Password are goals the actor opens deliberately, so they never extend another use case. Wired as a sub-flow, the renderer drops its actor edge and it reads as a subroutine. Log In as the **base** of an extend (e.g. a second-factor check on an unknown device) is valid UML and is not flagged. Mode 1 keeps this rule: it is a modelling error in any language, and the phrase list carries Vietnamese forms.

## LLM yellow flags

Not here — see `review-section` (S-9.2, UC 6.9): FR↔NFR contradictions, security risks, ambiguous wording. Out of scope for round one (Phases §9.1) but the schema is ready.
