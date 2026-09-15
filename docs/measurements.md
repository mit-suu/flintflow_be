# Measurements

Shared by T14, T18, T22 — each task adds its own section below. Do not remove another task's section.

## S-2/S-3 content skills on `spine-fixture-minimal.json` (T14)

Source: `src/modules/pipeline/skills/s2-s3.e2e.test.ts`, mock-provider test (`npx vitest run
src/modules/pipeline/skills/s2-s3.e2e.test.ts`), re-run 2026-09-15 after the review-fix pass (C4/C5:
`project.vision/goals/release_scope/type/domain/complexity` start null/empty in `seedSpine()`, S-1.2/
S-2.1/S-2.2 now draft real `set` ops instead of `ops: []`; S-2.5 is reopened once via `gate` `revision` +
`accept` after S-3.1 stales its context diagram — see task report for the full scenario). Steps: S-1.2,
S-2.1…S-2.5, S-3.1…S-3.6 via `runStep` + `gate` accept on the minimal fixture (`project{}` + `addendum[]`
only), plus one extra `gate revision` + `gate accept` round on S-2.5.

**All numbers below are from the mock provider**, not a real model call. `E2E_AI=1` was not run tonight
(no API key / live Mongo / wallet available in this harness — see task report). The mock's `tokensUsed`
is an estimate (`Math.ceil(text.length / 4)` on the serialized `promptVariables` for tokens-in and on the
serialized op batch for tokens-out — same heuristic as `context-projection.ts#estimateTokens`), and `cost`
is a placeholder unit (`(tokens_in + tokens_out) * 0.000002`), not the real credit pricing table
(`meter.service.ts`). Treat this table as *relative* shape (which steps are heavier), not absolute spend.

S-3.6 is render-only (no skill, no model call) — 0 rows, by design. S-2.5 is also render-only for the main
loop, but gets one extra **draft/revision** row below from the C4 reopen round (its op-case fixture is
still `ops: []` — the call proves the reopen path, not a Spine write).

| Step | Call | Tokens in (est.) | Tokens out (est.) | Cost (mock unit) | Real (pending `E2E_AI=1`) |
| --- | --- | ---: | ---: | ---: | --- |
| S-1.2 | elicit | 335 | 1 | 0.000672 | — |
| S-1.2 | draft | 345 | 152 | 0.000994 | — |
| S-2.1 | elicit | 196 | 1 | 0.000394 | — |
| S-2.1 | draft | 209 | 213 | 0.000844 | — |
| S-2.2 | elicit | 299 | 1 | 0.000600 | — |
| S-2.2 | draft | 329 | 223 | 0.001104 | — |
| S-2.3 | elicit | 167 | 1 | 0.000336 | — |
| S-2.3 | draft | 195 | 198 | 0.000786 | — |
| S-2.4 | elicit | 264 | 1 | 0.000530 | — |
| S-2.4 | draft | 289 | 240 | 0.001058 | — |
| S-3.1 | elicit | 171 | 1 | 0.000344 | — |
| S-3.1 | draft | 194 | 389 | 0.001166 | — |
| S-3.2 | elicit | 323 | 1 | 0.000648 | — |
| S-3.2 | draft | 348 | 865 | 0.002426 | — |
| S-3.3 | elicit | 921 | 1 | 0.001844 | — |
| S-3.3 | draft | 949 | 420 | 0.002738 | — |
| S-3.4 | elicit | 1205 | 1 | 0.002412 | — |
| S-3.4 | draft | 1229 | 182 | 0.002822 | — |
| S-3.5 | elicit | 1210 | 1 | 0.002422 | — |
| S-3.5 | draft | 1238 | 240 | 0.002956 | — |
| **Subtotal** (main loop, 20 calls, 10 steps) | | **10416** | **3132** | **0.027096** | — |
| S-2.5 | draft (C4 reopen, `gate revision`) | 265 | 40 | 0.000610 | — |
| **Total** (21 calls) | | **10681** | **3172** | **0.027706** | — |

### Observations

- `elicit` tokens-out is always `1` — the mock always answers `"ok"` with no questions (Coaching mode
  always elicits once per step in this harness). A real model's elicit reply is longer; this column will
  change once `E2E_AI=1` runs.
- `draft` tokens-in grows with the projection: S-3.4/S-3.5 carry the largest `use_cases[]` projection (16
  entries by then), hence the highest input estimate of the main loop.
- `draft` tokens-out tracks the size of the op batch each fixture emits — S-3.2 (11 new use cases) and
  S-3.3 (5 more) are the heaviest write steps; S-1.2/S-2.1/S-2.2 now draft real `set` ops (project
  classification, vision/goals, release scope — C5 fix) instead of `ops: []`, so their draft tokens-out is
  no longer the minimal `{"ops":[]}` shape.
- The S-2.5 reopen row (C4) is a `revision` call, not `draft`/`elicit` — `redraft()` (`gate.service.ts`)
  always calls `runDraftPhase` even for a render-only step with an empty writable set; its op-case fixture
  (`fixtures/op-cases/s2-s3/s-2.5.json`) is `ops: []`, so the call proves the reopen round-trips through
  `draftOps`/`applyTransaction` without writing anything, then re-renders the context diagram.

### DoD status (from this same test run)

- Mock e2e: **green** (`npx vitest run src/modules/pipeline/skills/s2-s3.e2e.test.ts`).
- `E2E_AI=1` (3 real-provider runs, 0 red flags in §1/§2, ≥5 actors, ≥12 use cases, usecase render ok):
  **not run** — no API key / live Mongo / wallet in this overnight harness. The `it.skipIf(process.env
  .E2E_AI !== "1")` branch in `s2-s3.e2e.test.ts` exercises the same assertions (now including the C4
  reopen round) through `defaultStepRunnerDeps()` with `seedSpine({ fast: true })` once run in an
  environment with those available.
- `non_english_content = 0`: verified by the mock test (asserted, not just measured) — final Spine has 0
  open `non_english_content` flags.
- Field counts at the end of the mock run: 5 actors (2 `system`, 2 `human`, 1 `time`), 2 roles, 16 use
  cases (≥ 12), 3 `business_rules[tier=high]`, context + usecase diagrams both `render_status: "ok"` (the
  context diagram's `diagram_stale` flag from S-3.1 is closed by the C4 reopen round before the final
  assertion).

## S-2/S-3 real provider through the HTTP API (M3 run, 2026-09-15)

Setup: local MongoDB (standalone), BE `wave3/decisions`, PlantUML via `plantuml.jar -picoweb` + a GET shim,
project prepared like `seedSpine({ fast: true })` (steps before S-1.2 accepted, §1 empty, `working_mode=fast`),
driven by script: `POST /resume` → per step `POST /run` (SSE, auto-answer `answer_needed`) → `POST /gate accept`.
Provider: `glm` / `zai-org/GLM-5.3-Flash` (Modal), after the GLM fixes `db0defe`, `1494a91`, `47e2b4a`, `c07b03f`
and skill/projection fixes `d2c258a`, `6259f25`. Numbers from `usages` (tokens as reported by the provider).

| Step | Call | State | Calls | Tokens in | Tokens out | Credit |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| S-1.2 | elicit | deducted | 1 | 1316 | 4492 | 1 |
| S-1.2 | draft | deducted | 1 | 2395 | 5142 | 4 |
| S-2.1 | elicit | deducted | 1 | 1126 | 3685 | 1 |
| S-2.1 | draft | deducted | 1 | 2175 | 8836 | 4 |
| S-2.2 | elicit | deducted | 1 | 1320 | 5159 | 1 |
| S-2.2 | draft | deducted | 1 | 2358 | 6091 | 4 |
| S-2.3 | draft | deducted | 1 | 2204 | 3117 | 4 |
| S-2.4 | draft | deducted | 1 | 2159 | 11105 | 4 |
| S-3.1 | elicit | deducted | 1 | 1110 | 3955 | 1 |
| S-3.1 | draft | deducted | 1 | 3023 | 9273 | 4 |
| S-3.2 | elicit | deducted | 1 | 1334 | 4050 | 1 |
| S-3.2 | draft | refunded | 1 | 0 | 0 | 0 |
| **Total (not refunded)** | | | 11 | 20520 | 64905 | 29 |

Result: **7/12 steps accepted** (S-1.2 … S-3.1, S-2.5 context diagram `ok`), wall time 20–86 s per step.
Stopped at **S-3.2 draft**: GLM-5.3-Flash kept reasoning (hidden `reasoning_content` > 50 000 chars) until
`finish_reason=length` at `max_tokens=12288`, 3/3 attempts ⇒ `GLM_EMPTY_OUTPUT`, draft usage refunded.

### Observations

- Input side matches the mock estimate shape (1.1k–3.0k tokens per call — projection works), but **tokens-out
  is 3–5× tokens-in**: almost all of it is hidden reasoning, not the op batch. Credit per call is flat
  (elicit 1, draft 4), so credit cost matches plan while provider cost is driven by reasoning.
- Earlier attempts (runs 1–7) failed on: reasoning mixed into `content` (`reasoning_effort: "none"` makes it
  worse), empty `content` at `max_tokens=2048`, `assumptions[]` entries missing `confirmed_at`, reused
  assumption id `AS3`. All fixed and covered by unit tests.
- Open red flags after S-3.1 are the expected empty S-3/S-4+ sections (`section_empty@fixed:2.2.1`,
  `fixed:2.2.2`); `non_english_content` = 0.
- DoD `E2E_AI` (3/3 runs, ≥ 5 actors, ≥ 12 use cases) is **not met**: blocked on the model choice for
  `actors-and-usecases` (S-3.2…S-3.5), not on pipeline code.
