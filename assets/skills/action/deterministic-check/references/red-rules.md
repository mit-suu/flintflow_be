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
| `usecase_relation_invalid` | A use case includes/extends itself, sits in an include or extend cycle, or the same pair carries both an include and an extend | S-3.4 | ✔ |

That is 11 rules. `placeholder` screens do **not** trigger `screen_pending_at_baseline`.

## The "not there yet" gate (FLF-213)

`section_empty`, `array_empty` and the "no NFR in this category at all" branch of `nfr_missing_number` say *X is missing*. Missing is only a defect once the step that produces X has been **accepted**; before that the slot is empty on plan. So each of them fires only when its owner step is accepted — all of them, for a section fed by several steps (`fixed:1` needs S-2.1 … S-2.5). A project sitting at S-3.6 therefore raises nothing for §3.1.x (S-4) or §4.x (S-6), and `readiness.red_open` counts real problems only.

Two runs open the gate and check every slot regardless:

- `at_baseline` (S-9) — by then every step must be done, so nothing may slip through under "not there yet".
- Mode 1 (`skipOwnerStepGate` in the rule profile) — the whole document arrives in one go and `steps[]` is *derived from the file* (a heading the file lacks becomes `pending`), so an empty slot is a gap to report, not a step not yet reached. This is what keeps D6 (FLF-183) working.

An NFR that **exists** but lacks `metric`/`threshold` is not gated: the data is already there, so a missing number is a defect whatever step is running.

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
| `screen_flow` | `screens[].name/.flow_to/.is_popup/.tabs` |
| `erd` | `entities[].name/.relations` |
| `screen_layout` | `screens[<owner>].name` · `functions[screen_id=<owner>].name/.description` |
