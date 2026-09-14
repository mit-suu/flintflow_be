# Credit price per call — T03 defaults (`DEFAULT_ACTION_COSTS`, overridable by active `PricingConfig`)

| `call_kind` (ActionType) | Credits | Typical use |
| --- | ---: | --- |
| `elicit` | 1 | One Elicit turn |
| `discovery_step` | 2 | B-0 … B-2 turn with capture ops |
| `draft` | 4 | First draft transaction of a step |
| `revision` | 3 | Request revision |
| `regenerate` | 4 | Regenerate (cap 3 per step) |
| `render_fix` | 1 | PlantUML compile-check fix (≤ 2 per diagram) |
| `review` | 2 | LLM lens review |
| `consistency_pass` | 3 | S-8.4 LLM half |
| `glossary_scan` | 2 | S-8.1 glossary extraction |
| `reconcile` | 4 | One-pass reconcile of stale sections |
| `change_instruction` | 3 | Chat change request → ops |
| `chat` | 2 | Free chat outside the pipeline |
| `summarize_document` | 2 | Once per uploaded document |

Legacy (removed at T21): `generate_section` 5 · `priority_ranking` 5 · `scope_out_of_scope` 5 · `chat_discovery` 2 · `diagram_classify` 1 · `diagram_generate` 4.

## Worked example — Coaching S-3.2

| Call | Kind | Credits | State |
| --- | --- | ---: | --- |
| 1 | elicit | 1 | deducted |
| 2 | draft (attempt 0, op path invalid) | 4 | refunded |
| 3 | draft (attempt 1) | 4 | deducted |
| 4 | review | 2 | deducted |

Parse/validation failure releases the reservation (Phases §4.2: refund on failure), so row 2 is `refunded` — but it still counts toward the cap of 8. Charged to the user: 7 credits; calls counted: 4.
