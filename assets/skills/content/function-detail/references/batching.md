# Batching the S-5 loop

> Human-facing reference. **Not loaded at runtime** (`draft-to-ops.ts#contentGuidance` calls `getSkill`
> without a `references` option) — the operative rules are inlined in `../SKILL.md`.

## Why batches exist

One screen can own 15–20 functions. Asking a 6k-token model to write `normal[]`, `abnormal[]` and
`validations[]` for all of them in one response produces two failure modes we measured in Wave 3:
the tail functions come back empty, or the JSON is truncated mid-array and the schema retry burns a
second call anyway.

## How the runner splits them

`step-runner.service.ts`:

- `FUNCTION_BATCH_SIZE = 6`.
- `functionBatches(spine, stepId)` returns `[[]]` (one call, unfiltered projection) for anything that is
  not `S-5.2`/`S-5.4`, or when the loop owns ≤ 6 functions.
- Otherwise it chunks the loop's functions by `order`, then `id`, into groups of ≤ 6.
- `batchContext(ctx, ids)` narrows every `functions*` key of the projection to that group. Nothing else
  changes — no new prompt variable, so `draft-to-ops.ts` (T11's file) stays untouched.

So the model never sees the functions it must not write, which is a stronger guarantee than telling it
not to.

## Consequences

- **Call budget.** Each batch is one `draft` call against the 8-calls-per-step ceiling
  (`CALLS_LIMIT`), and the step also spends one `elicit` call. A screen with more than ~42 functions
  therefore cannot finish in one round: it stops at `CALL_LIMIT` and the user accepts what exists at the
  gate. That is deliberate — no loop-specific exemption from the ceiling.
- **Step count is unchanged.** Batching happens *inside* `S-5.4@<screen>`; it does not add steps, so the
  `51 + 5 × N` total in the progress bar stays exact.
- **Regenerate.** A gate `regenerate` reverts the step's whole seq range and redrafts — every batch runs
  again, not just the last one.

## Ordering

Functions are sorted by `order` then `id` before chunking, so batch membership is stable across runs.
A resume that re-enters the step re-derives the same groups from the same Spine.
