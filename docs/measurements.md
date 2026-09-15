# Measurements

Shared by T14, T18, T22 — each task adds its own section below. Do not remove another task's section.

## S-2/S-3 content skills on `spine-fixture-minimal.json` (T14)

Source: `src/modules/pipeline/skills/s2-s3.e2e.test.ts`, mock-provider test (`npx vitest run
src/modules/pipeline/skills/s2-s3.e2e.test.ts`), run 2026-09-15. Steps: S-1.2, S-2.1…S-2.5, S-3.1…S-3.6
via `runStep` + `gate` accept on the minimal fixture (`project{}` + `addendum[]` only).

**All numbers below are from the mock provider**, not a real model call. `E2E_AI=1` was not run tonight
(no API key / live Mongo / wallet available in this harness — see task report). The mock's `tokensUsed`
is an estimate (`Math.ceil(text.length / 4)` on the serialized `promptVariables` for tokens-in and on the
serialized op batch for tokens-out — same heuristic as `context-projection.ts#estimateTokens`), and `cost`
is a placeholder unit (`(tokens_in + tokens_out) * 0.000002`), not the real credit pricing table
(`meter.service.ts`). Treat this table as *relative* shape (which steps are heavier), not absolute spend.

S-2.5 and S-3.6 are render-only (no skill, no model call) — 0 rows, by design.

| Step | Call | Tokens in (est.) | Tokens out (est.) | Cost (mock unit) | Real (pending `E2E_AI=1`) |
| --- | --- | ---: | ---: | ---: | --- |
| S-1.2 | elicit | 611 | 1 | 0.001224 | — |
| S-1.2 | draft | 642 | 37 | 0.001358 | — |
| S-2.1 | elicit | 469 | 1 | 0.000940 | — |
| S-2.1 | draft | 490 | 33 | 0.001046 | — |
| S-2.2 | elicit | 451 | 1 | 0.000904 | — |
| S-2.2 | draft | 481 | 29 | 0.001020 | — |
| S-2.3 | elicit | 167 | 1 | 0.000336 | — |
| S-2.3 | draft | 195 | 302 | 0.000994 | — |
| S-2.4 | elicit | 264 | 1 | 0.000530 | — |
| S-2.4 | draft | 289 | 240 | 0.001058 | — |
| S-2.5 | — (render only) | — | — | — | — |
| S-3.1 | elicit | 213 | 1 | 0.000428 | — |
| S-3.1 | draft | 236 | 230 | 0.000932 | — |
| S-3.2 | elicit | 323 | 1 | 0.000648 | — |
| S-3.2 | draft | 348 | 865 | 0.002426 | — |
| S-3.3 | elicit | 921 | 1 | 0.001844 | — |
| S-3.3 | draft | 949 | 420 | 0.002738 | — |
| S-3.4 | elicit | 1205 | 1 | 0.002412 | — |
| S-3.4 | draft | 1229 | 182 | 0.002822 | — |
| S-3.5 | elicit | 1210 | 1 | 0.002422 | — |
| S-3.5 | draft | 1238 | 240 | 0.002956 | — |
| S-3.6 | — (render only) | — | — | — | — |
| **Total** (20 calls, 10 steps) | | **11931** | **2588** | **0.029038** | — |

### Observations

- `elicit` tokens-out is always `1` — the mock always answers `"ok"` with no questions (Coaching mode
  always elicits once per step in this harness). A real model's elicit reply is longer; this column will
  change once `E2E_AI=1` runs.
- `draft` tokens-in grows with the projection: S-3.4/S-3.5 carry the largest `use_cases[]` projection (16
  entries by then), hence the highest input estimate of the run.
- `draft` tokens-out tracks the size of the op batch each fixture emits — S-3.2 (11 new use cases) and
  S-3.3 (5 more) are the heaviest write steps; S-1.2/S-2.1/S-2.2 emit `ops: []` (Brief already satisfies
  them) so their draft tokens-out is the minimal `{"ops":[]}` shape.

### DoD status (from this same test run)

- Mock e2e: **green** (`npx vitest run src/modules/pipeline/skills/s2-s3.e2e.test.ts`).
- `E2E_AI=1` (3 real-provider runs, 0 red flags in §1/§2, ≥5 actors, ≥12 use cases, usecase render ok):
  **not run** — no API key / live Mongo / wallet in this overnight harness. The `it.skipIf(process.env
  .E2E_AI !== "1")` branch in `s2-s3.e2e.test.ts` exercises the same assertions through
  `defaultStepRunnerDeps()` once run in an environment with those available.
- `non_english_content = 0`: verified by the mock test (asserted, not just measured) — final Spine has 0
  open `non_english_content` flags.
- Field counts at the end of the mock run: 5 actors (2 `system`, 1 `time`, 2 `human`), 2 roles, 16 use
  cases (≥ 12), 3 `business_rules[tier=high]`, context + usecase diagrams both `render_status: "ok"`.
