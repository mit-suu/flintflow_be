# Deterministic check — implementation notes (T09)

Rule tables: `red-rules.md`, `yellow-rules.md`. Code: `src/modules/spine/deterministic-check.ts`. This file records how the code resolves points the tables leave open. It is documentation only and is never sent to a model.

| Topic | Decision |
| --- | --- |
| `section_id` | Always a resolvable section key. The engine writes flags through ops, and invariant 3 rejects dead keys. When a rule cannot derive a key, it falls back to `fixed:I`. |
| `target_id` | Element id. For `dead_reference` it is the concrete `refPath` (`use_cases[id=UC01].actor_ids[=A08]`), so two dead keys in one section stay two flags. For `array_empty` it is the array label. |
| `dead_reference` section / remediation | `use_cases[]` → `fixed:2.2.2` (S-3.2, include/extend S-3.4). `screens[].feature_id`, `.primary_function_id` → `fixed:3.1.2` (S-4.1). `flow_to` → `fixed:3.1.1` (S-4.2). `permissions[]` → `fixed:3.1.3` (S-4.3). `roles[].actor_id` → `fixed:3.1.3` (S-3.1). `functions[]` → `function:<id>`. `entities[].relations` → `fixed:3.1.5` (S-4.5). `source_validation_ids` → `fixed:5.1` (S-7.1). `messages[]` → `fixed:5.3` (S-7.3). Diagram owner → the diagram's section and render step. Assumption path → `fixed:5.4` (its `origin_step_id`). Progress and steps keys → `fixed:3.1.2` (S-5.1). |
| `section_empty` | Checked only for mandatory non-derived fixed sections. The owns-column test lives in `SECTION_HAS_DATA`. `feature:*`/`function:*` exist only when their element exists; an empty `features[]`/`functions[]` is caught by `array_empty`. |
| `diagram_stale` | Skipped while `source_hash` is `""` or `"TBD"` (never computed). The hash is `computeSourceHash` in `source-hash.ts`, and T10 must write the same value. |
| `nfr_missing_number` | When a category is empty: one flag with `target_id = null`. Otherwise one flag per NFR missing `metric` or `threshold`. |
| S-9 rules | `unconfirmed_assumption`, `section_stale_at_baseline`, `section_awaiting_reaccept` and `screen_pending_at_baseline` run only with `atBaseline`. |
| `awaiting_reaccept` | Derived from `steps[]`: an owner step with `status = revision_requested`. |
| `non_english_content` | One flag per element; the message lists the offending field paths. Diagram `puml` is scanned too, because labels must be English. |
| Remediation for function sections | `S-5.2@<screen_id>` for content, `S-5.4@<screen_id>` for business-rule keys; `@nonscreen` when `screen_id = null`. |
