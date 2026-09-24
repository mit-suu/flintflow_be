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
| `original_diagram_stale` | Mode 1 only: a diagram kept as the **user's original image** (`custom_sections[].blocks[].diagram`, §4.13) no longer matches the Spine data it shows (`computeSourceHash` ≠ hash at import) — e.g. a CR added a use case and the reviewer rejected the redraw. Section = the FPT section of that diagram kind | render step of the kind |

Cardinality is **yellow, not red**: as red, every `placeholder` screen of round one would hit `screen_no_function` and need mass waivers.

## The "not there yet" gate (FLF-213)

The cardinality rules, `orphan_screen` and `usecase_floating` / `function_without_uc` all read *X has no Y*, so they only mean something once Y can exist. Each waits for the step that **produces Y**, which is not always its `remediation_step`:

| `rule_id` | Waits for | Why |
| --- | --- | --- |
| `orphan_actor` | S-3.2 | actors are tied to use cases in the Actor-Goal List |
| `usecase_no_function` | S-4.4 | `use_cases[].function_ids` is filled at S-4.1 (screen functions) and S-4.4 (non-screen ones); the fix is still S-3.2 |
| `screen_no_function` | S-4.1 | functions are created there |
| `orphan_screen` | S-4.2 | `flow_to[]` is written there; the rule also self-guards on the data being present at all |
| `empty_feature` | S-4.1 | screens and functions are created there |
| `role_no_actor` | S-3.1 | roles and actors both come from S-3.1 |
| `usecase_floating` | S-3.4 | `extends[]` is written there |
| `function_without_uc` | S-4.4 | non-screen functions and their use case links come from S-4.4 |

"Waits for" means that step is `accepted`. `at_baseline` (S-9) and mode 1 open every gate — see `red-rules.md`. `screen_placeholder` has its own gate (past the S-5 loop) and `system_name_missing` its own condition (a diagram exists); the naming, language and relation rules judge data that is already there, so they never wait.

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
