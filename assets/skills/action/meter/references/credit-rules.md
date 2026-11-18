# Credit price per call - server-configured reserve ceilings (`DEFAULT_ACTION_COSTS`)

Reserve amounts are configured solely on the server via `DEFAULT_ACTION_COSTS` (`credit-reservation.service.ts`) and act as per-call ceilings. After a successful parse, `deductCredit` settles actual token consumption via `calculateActualCreditCost` and releases any unused hold back to `available`.

## Actual-token settlement (`calculateActualCreditCost`)

- `TOKEN_CREDIT_WEIGHTS = { inputPer1k: 0.25, outputPer1k: 1.0 }`
- `reservedCost <= 0` (free actions such as `knowledge_answer`): settles `0`.
- `tokens === undefined`: settles `reservedCost`.
- Otherwise: `Math.min(reservedCost, Math.max(1, Math.ceil((Math.max(0, tokensIn) / 1000) * 0.25 + (Math.max(0, tokensOut) / 1000) * 1.0)))`.
- When `previousState === "reserved"`, `balance` decreases by `actualCost` and `reserved` decreases by full `reservedCost`.
- When `previousState === "expired"`, the hold was already released so `deductCredit` decreases `balance` by `actualCost` on `available` without decrementing `reserved`.

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

## Worked example - S-3.2

| Call | Kind | Credits | State |
| --- | --- | ---: | --- |
| 1 | elicit | 1 | deducted |
| 2 | draft (attempt 0, op path invalid) | 4 | refunded |
| 3 | draft (attempt 1) | 4 | deducted |
| 4 | review | 2 | deducted |

Parse/validation failure releases the reservation (Phases §4.2: refund on failure), so row 2 is `refunded` - but it still counts toward the cap of 8. Charged to the user: 7 credits; calls counted: 4.
