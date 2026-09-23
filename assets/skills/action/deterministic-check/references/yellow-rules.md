# Yellow flags (cardinality) — source: srs-spine.md §8.1

Deterministic, non-blocking, each with a `rule_id`.

| `rule_id` | Condition | `remediation_step` |
| --- | --- | --- |
| `orphan_actor` | `actors[kind=human]` not in any `use_cases[].actor_ids[]` | S-3.2 |
| `usecase_no_function` | `use_cases[].function_ids[]` empty | S-3.2 |
| `screen_no_function` | A screen has no function | S-4.1 |
| `orphan_screen` | A screen no human actor uses (once any screen ↔ actor link exists), or, once any `flow_to` edge exists, a screen with no incoming and no outgoing edge, or a pop-up nothing opens | S-4.2 |
| `empty_feature` | A feature has neither screen nor function | S-4.1 |
| `role_no_actor` | `roles[].actor_id` is null | S-3.1 |
| `non_english_content` | A field in the **Owns** column contains Vietnamese diacritics | owner step of the field |

Cardinality is **yellow, not red**: as red, every `placeholder` screen of round one would hit `screen_no_function` and need mass waivers.

## `non_english_content`

- Scan only fields that render into the SRS (Owns column of srs-spine §4).
- Skip `addendum[].content` (verbatim user text), `glossary[].term_native`, `changes[].reason`, `flags[].message`, `waive_reason` — those follow the user's language by design (Phases §1.3).
- Detection: any character in the Vietnamese diacritic ranges (e.g. `/[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i`).
- `target_id` = element id; `message` names the field path.

## LLM yellow flags

Not here — see `review-section` (S-9.2, UC 6.9): FR↔NFR contradictions, security risks, ambiguous wording. Out of scope for round one (Phases §9.1) but the schema is ready.
