# Red flags — source: srs-spine.md §6, §7, §7.1

| `rule_id` | Condition | `remediation_step` | Waivable |
| --- | --- | --- | :---: |
| `section_empty` | Mandatory section (invariant 1, excluding derived) has no field with data | owner step of the section (inverse of the field → section map) | ✔ |
| `array_empty` | An array of invariant 2 is empty | step that produces the array | ✘ |
| `dead_reference` | A key in `reference_fields[]` does not exist | step owning the field that holds the key | ✘ |
| `render_error` | `diagrams[].render_status = error` | step rendering that diagram | ✘ |
| `diagram_stale` | `diagrams[].source_hash` ≠ current hash of its `source_fields` | step rendering that diagram | ✔ |
| `nfr_missing_number` | `count(nfrs[category=reliability]) = 0` **or** `count(nfrs[category=performance]) = 0` **or** an element of those two lacks `metric`/`threshold` | S-6.3 / S-6.4 | ✔ |
| `unconfirmed_assumption` | `count(assumptions[status=unconfirmed]) > 0` at S-9 | `assumptions[].origin_step_id`, or S-9.1 sweep | ✔ |
| `section_stale_at_baseline` | `status(s) = stale` for a mandatory `s` | reconcile, or re-Accept at owner step | ✔ |
| `section_awaiting_reaccept` | `awaiting_reaccept = true` for a mandatory `s` | owner step's gate | ✔ |
| `screen_pending_at_baseline` | `screens[].detail_status = pending` | S-5 for that screen | ✔ |
| `orphan_screen_at_baseline` | Same condition as yellow `orphan_screen`, checked at S-9: a screen no human actor uses, or isolated in the flow, or a pop-up nothing opens | S-4.2 | ✔ |

That is 11 rules. Mode 1 (import) excludes `orphan_screen_at_baseline`. `placeholder` screens do **not** trigger `screen_pending_at_baseline`.

## Mandatory sections (invariant 1)

`fixed:1` · `fixed:2.1` · `fixed:2.2.1` · `fixed:2.2.2` · `fixed:3.1.1` … `fixed:3.1.5` · `feature:*` (≥ 1) · `function:*` (≥ 1) · `fixed:4.1` · `fixed:4.2.1` · `fixed:4.2.2` · `fixed:4.2.3` · `fixed:5.1` … `fixed:5.5`. `fixed:4.2.4` optional. `fixed:I`, `fixed:5.5` derived.

## Arrays that must not be empty (invariant 2)

`actors[]`, `actors[kind=human]`, `screens[]`, `entities[]`, `use_cases[]`, `features[]`, `functions[]`, `roles[]`, `nfrs[category=reliability]`, `nfrs[category=performance]`, `common_requirements[]`.

## Owner step per section (for remediation)

| Section | Owner steps |
| --- | --- |
| `fixed:1` | S-2.1 … S-2.5 |
| `fixed:2.1` | S-3.1 |
| `fixed:2.2.1` | S-3.6 |
| `fixed:2.2.2` | S-3.2 … S-3.5 |
| `fixed:3.1.1` | S-4.2 |
| `fixed:3.1.2` | S-4.1 |
| `fixed:3.1.3` | S-4.3 |
| `fixed:3.1.4` | S-4.4 |
| `fixed:3.1.5` | S-4.5 |
| `feature:<id>` | S-4.1 |
| `function:<id>` | S-5.2 / S-5.4 @ its screen (or @nonscreen) |
| `fixed:4.1` … `fixed:4.2.4` | S-6.1 … S-6.5 |
| `fixed:5.1` … `fixed:5.4` | S-7.1 … S-7.4 |
| `fixed:5.5` | S-8.1 |

## `source_fields` for `diagram_stale` (§7.1)

Hash over a projection sorted by `id`, containing only fields actually drawn:

| `kind` | `source_fields` |
| --- | --- |
| `context` | `project.name` · `actors[kind≠human].name` |
| `usecase` | `actors[].name/.kind` · `use_cases[].name/.actor_ids/.includes/.extends` |
| `screen_flow` | `screens[].name/.flow_to/.is_popup/.tabs` · `actors[kind=human].name` · screen ↔ actor links (`permissions`→`roles.actor_id`, `use_cases.actor_ids`×`function_ids`→`functions.screen_id`) |
| `erd` | `entities[].name/.relations` |
| `screen_layout` | `screens[<owner>].name` · `functions[screen_id=<owner>].name/.description` |
