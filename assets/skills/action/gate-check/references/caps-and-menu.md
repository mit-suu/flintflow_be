# Caps, counters and edge cases — source: Phases §3, §4.1, §4.2, §5.1

## Counters

| Counter | Scope | Increments on | Resets on |
| --- | --- | --- | --- |
| `calls` | step (S-5: step@screen) | every model call of any kind, successful or not | step `accepted` |
| `regenerates` | step; **function** at S-5.4 | Regenerate action | step `accepted` |
| `elicit_turns_this_phase` | phase | Elicit turn (Fast path enforcement) | phase change |

Counters are derived from `usage[]` rows with `step_id` and `call_kind` since the step's last `accepted_at` — not stored separately — so they survive resume.

## Cap table

| Situation | Allowed actions |
| --- | --- |
| calls < 8, regenerates < 3 | Accept · Request revision · Regenerate |
| calls < 8, regenerates = 3 | Accept · Request revision |
| regenerates = 3 and last revision did not resolve | + **Accept as-is** |
| calls = 8 | Accept · Accept as-is |

## Accept as-is

- Requires a user reason (free text).
- Writes `flags[]` `{ level: yellow, rule_id: "accepted_as_is", section_id: <each fed section>, message: <reason> }`.
- Does not suppress red flags; they still block baseline.

## Conflicts

`base_version` ≠ current `spine_version` when the transaction arrives (two tabs):

- Reject the transaction, **refund** the call's credit (`usage[].state = refunded`).
- Keep the user's Elicit answers; offer to draft again.
- Does not count toward the regenerate cap.

## Fast path phase gate

- One card lists every step of the phase with its ops summary.
- Accept applies to all steps; Request revision names the step(s); Regenerate applies to one step at a time.
- Assumptions created in the phase are shown grouped by `target_section`.

## Deterministic steps

S-8.2, S-8.3, S-9.1, S-9.5 have no model calls, so no regenerate; their gate is Accept (or, for S-9.5, sign-off when red = 0).
