---
skill_id: meter
kind: action
version: 1.0.0
description: Reserve / deduct / refund credit per model call and record usage[] (UC 9.6)
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 512
temperature: 0
reads:
  - usage[]
  - steps[]
writes:
  - usage[]
output_schema: none
language: user
---

# Meter

Contract for `meter.service.ts` (T13) on top of the credit ledger (T04, `credit-reservation.service.ts`). **No model call.**

## Unit of charge

**Per model call, not per step** (Phases §4.2). A step makes several calls; reserving a whole step would run out of credit mid-step and leave applied ops behind an unfinished step.

## Lifecycle of one call

```text
reserve(call_kind)      → usage[] { state: reserved, expires_at: now + TTL }
call model
  success & parsed      → deduct   → state: deducted, tokens_in/out, cost
  failure / parse fail  → release  → state: refunded
  base_version conflict → release  → state: refunded   (does not consume regenerate cap)
```

Row shape (srs-spine §2):

```text
usage[] { id, step_id, call_kind, attempt, tokens_in, tokens_out, cost,
          state: reserved|deducted|refunded, expires_at }
```

- `call_kind` = ActionType (`elicit`, `draft`, `render_fix`, `review`, `regenerate`, `revision`, `discovery_step`, `consistency_pass`, `glossary_scan`, `reconcile`, `change_instruction`).
- `attempt` = 0 for the first try, 1–2 for schema retries of the same call.
- `step_id` includes `@screen_id` for S-5.

Price table: `references/credit-rules.md`.

## Rules

1. **Reserve before every call**; insufficient credit ⇒ do not call the model, return `INSUFFICIENT_CREDIT` (402). Ops already applied by accepted steps stay.
2. **Expiry**: `reserved` rows past `expires_at` are released by a sweeper. Closing the tab mid-call must not leave credit hanging.
3. **Deterministic steps** S-8.2, S-8.3, S-9.1, S-9.5 never Meter. Running out of credit must never block writing `baselines[]`.
4. **Refunded rows** are excluded from reported cost (UC 10.3) but included in real provider cost.
5. **Schema retries** of the same call are separate reservations with `attempt` 1–2 — the provider charged for them.
6. `[P]` Party mode is the most expensive action; show the estimate and ask before running.
7. The call counter of `gate-check` is derived from `usage[]` rows — keep `step_id` and `call_kind` accurate.

## Refuse

- Charging per step or per phase.
- Deducting before the response is parsed and validated.
- Silent top-up or negative balance.
