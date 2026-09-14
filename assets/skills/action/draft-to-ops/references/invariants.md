# Invariants and cascade — source: srs-spine.md §3, §4.1, §6

Violation ⇒ the **whole transaction is rejected**. Checked at the end of the batch, for Draft and for change flows alike.

| # | Invariant |
| --- | --- |
| 1 | Mandatory sections cannot be removed: `fixed:1`, `fixed:2.1`, `fixed:2.2.1`, `fixed:2.2.2`, `fixed:3.1.1`…`fixed:3.1.5`, `feature:*` (≥ 1), `function:*` (≥ 1), `fixed:4.1`, `fixed:4.2.1`, `fixed:4.2.2`, `fixed:4.2.3`, `fixed:5.1`…`fixed:5.5`. `fixed:4.2.4` optional. `fixed:I` and `fixed:5.5` are derived |
| 2 | The **last** element cannot be removed from: `actors[]`, `actors[kind=human]`, `screens[]`, `entities[]`, `use_cases[]`, `features[]`, `functions[]`, `roles[]`, `nfrs[category=reliability]`, `nfrs[category=performance]`, `common_requirements[]` |
| 3 | Every key in `reference_fields[]` points to an existing element |
| 4 | `functions[].screen_id` ∈ `screens[]` or `null`. `screens[].feature_id` and `functions[].feature_id` are **not null** |
| 5 | `features[].order` unique and contiguous from 0. `functions[].order` unique within a feature, counted **separately** for `screen_id ≠ null` and `screen_id = null` |
| 6 | `functions[].feature_id == screens[functions[].screen_id].feature_id` when `screen_id ≠ null` |
| 7 | Exactly one `sessions[is_pipeline = true]` per project |
| 8 | `screens[id = progress.screen_cursor]` cannot be removed. Adding a screen while `current_phase = S-5` appends to `screen_queue[]` with `detail_status = pending` |

## `reference_fields[]` (authoritative list)

```text
use_cases[].actor_ids[]        use_cases[].function_ids[]     use_cases[].includes[]
use_cases[].extends[]          screens[].feature_id           screens[].flow_to[]
screens[].primary_function_id  permissions[].screen_id        permissions[].role_id
roles[].actor_id               functions[].screen_id          functions[].feature_id
functions[].business_rule_ids[]  entities[].relations[]
business_rules[].source_validation_ids[]                      messages[].function_ids[]
diagrams[].owner_id            addendum[].target_section      flags[].section_id
assumptions[].path             sections[].id
progress.screen_cursor         progress.screen_queue[]        steps[].id (@screen_id part)
```

## Cascade the engine adds (you may also emit them explicitly)

| Remove | Also in the same batch |
| --- | --- |
| screen `X` | `functions[screen_id=X]`, `permissions[screen_id=X]`, `X` from every `flow_to[]`, those functions from `use_cases[].function_ids[]` and `messages[].function_ids[]`, `X` from `screen_queue[]`, `steps[id ~ @X]`, `sections[function:*]` of removed functions |
| actor `A` | `A` from `use_cases[].actor_ids[]`; `roles[actor_id=A].actor_id → null` |
| feature `F` (middle) | its screens/functions (cascade above) + `renumber features[]` |
| function `FN` | from `use_cases[].function_ids[]`, `messages[].function_ids[]`; `screens[primary_function_id=FN] → null`; `renumber` siblings |
| validation `V` | from `business_rules[].source_validation_ids[]` |

If a cascade would itself break an invariant (e.g. removing the last screen), the engine rejects the batch and returns the list of referrers for the user to decide. Do not work around it.
