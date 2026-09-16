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

## S-2/S-3 real provider — GLM-5.3-Flash with `reasoning_effort: "low"` (runs 12–17, 2026-09-15)

Decision: keep GLM-5.3-Flash (the only model on the Modal endpoint), send `reasoning_effort: "low"` +
`response_format: json_object` (`7618fe7`). Runs 15–17 also use the tuned `actors-and-usecases` /
`product-overview` skills and `reads` with `project.goals/release_scope` (`be189e2`). Same harness as above,
each run ends with `POST /assemble` + `GET /export/word`.

| Run | Skills | Steps | Calls | Tokens in | Tokens out | Credit | Actors (kinds) | Use cases | Red in §1/§2 | non-English | Diagrams | Docx |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | --- | ---: |
| 12 | before tuning | 12/12 | 15 | 35 352 | 6 727 | 45 | 2 (human) | 7 | 0 | 0 | context ok, usecase ok | 63 KB |
| 13 | before tuning | 12/12 | 16 | 37 765 | 6 827 | 49 | 2 (system, human) | 7 | 0 | 0 | ok, ok | 55 KB |
| 14 | before tuning | 12/12 | 17 | 45 736 | 9 459 | 53 | 4 (system, human, time) | 9 | 0 | 0 | ok, ok | 83 KB |
| 15 | tuned | 12/12 | 16 | 45 805 | 9 214 | 49 | 4 (system, human, time) | **15** | 0 | 0 | ok, ok | 156 KB |
| 16 | tuned | 12/12 | 17 | 43 967 | 8 935 | 53 | 3 (system, human) | 11 | 0 | 0 | ok, ok | 98 KB |
| 17 | tuned | 12/12 | 16 | 46 530 | 10 151 | 49 | 3 (human) | 10 | 0 | 0 | ok, ok | 114 KB |

Per-step shape (run 15): elicit 1.1k–2.8k in / 0.1k–0.6k out; draft 2.1k–5.0k in (S-3.x largest, projection
grows with `use_cases[]`) / 0.1k–3.0k out (S-3.1 heaviest); S-2.1 needed one schema retry.

### Observations

- Reliability: **6/6 runs complete S-1.2 → S-3.6 → assemble → Word** through the API; 0 red flags in scope,
  `non_english_content` = 0, context + usecase diagrams `ok` every time. Step wall time 1–28 s.
- Cost: `effort=low` cut tokens-out ~7× versus runs 1–8 (9–10k vs 65k for fewer steps); credit per full
  S-1.2→S-3.6 run is 45–53 (≈ 2–4 credit per step), in line with the Phases §4.2 pricing — no projection
  change needed before Wave 4.
- Completeness varies run to run (actors 3–4, use cases 10–15). Tuning raised use cases (7 → 10–15) but the
  model still rarely derives a payment-gateway actor from "credit reservation and metering" and sometimes
  skips the `time` actor. DoD thresholds ≥ 5 actors / ≥ 12 use cases: **met 0/3** (run 15 meets use cases only).

## S-2/S-3 real provider — enriched fixture brief (runs 18–20, 2026-09-15)

Decision (user): keep the DoD thresholds; add the missing facts to the Brief instead of padding the model output.
`spine-fixture-minimal.json` gains AD06–AD10 (`52f4772`): VietQR payment service + webhook, external AI model
provider, email service (`fixed:1`), scheduled credit/subscription jobs (`fixed:2.1`), administrator operations
(`fixed:2.2.2`) — all already-decided FlintFlow facts (T04, T06, Phases §9.1). Same skills/params as runs 15–17.

| Run | Steps | Calls | Tokens in | Tokens out | Credit | Actors (kinds) | Use cases | includes / extends | Red in §1/§2 | non-English | Diagrams | Docx |
| --- | --- | ---: | ---: | ---: | ---: | --- | ---: | --- | ---: | ---: | --- | ---: |
| 18 | 12/12 | 16 | 48 895 | 11 279 | 49 | **6** (3 system, 2 human, 1 time) | **21** | 6 / 4 | 0 | 0 | context ok, usecase ok | 226 KB |
| 19 | 12/12 | 16 | 53 119 | 11 957 | 49 | **7** (3 system, 3 human, 1 time) | **21** | 8 / 2 | 0 | 0 | ok, ok | 217 KB |
| 20 | 12/12 | 16 | 50 154 | 10 711 | 49 | **6** (3 system, 2 human, 1 time) | **20** | 5 / 4 | 0 | 0 | ok, ok | 200 KB |

**DoD `E2E_AI`: met 3/3** (≥ 5 actors, ≥ 12 use cases, 0 red in §1/§2, usecase `render_status=ok`).
Every run derived Payment Gateway, AI Model Provider, Email Service, Credit Scheduler and Administrator from the
Brief. Cost stays flat at 49 credit / full S-1.2→S-3.6 run (~50k tokens in, ~11k out); more addendum raises input
~10% versus runs 15–17.

## S-4 → S-8.1 (T18) — mock provider, `s4-s8.e2e.test.ts` (2026-09-16)

Harness: `spine-fixture-minimal.json` + the T14 op cases (S-1.2…S-3.5) applied through the real op engine,
then `nextStep` walked from S-4.1 to S-8.1 with `runStep` + `gate accept`. Provider mocked; op batches come
from `fixtures/op-cases/s4-s8/*.json`. Token figures are the char/4 estimate of the actual prompt variables
and the actual response JSON — **not** provider-reported numbers, so they are comparable across runs of this
harness but not directly with the real-provider tables above.

Shape of the run: 2 features, 4 screens (S91 core with **15 functions**, S92 core with 2, S93/S94
placeholders), 1 non-screen function ⇒ **N = 5** (4 screens + the `@nonscreen` round) and
`totalSteps = 51 + 5 × 5 = 76`. The loop executed 15 steps — S91, S92 and `@nonscreen` only; both
placeholder screens were skipped by `nextStep` and kept their `functions[]` frame.

| Step | Calls (elicit+draft) | Tokens in | Tokens out |
| --- | ---: | ---: | ---: |
| S-4.1 | 2 | 2 437 | 1 987 |
| S-4.2 | 2 | 2 344 | 110 |
| S-4.3 | 2 | 1 886 | 477 |
| S-4.4 | 2 | 2 209 | 166 |
| S-4.5 | 2 | 1 742 | 275 |
| S-5.2@S91 | **4** (1 + 3 batches) | 8 437 | 1 245 |
| S-5.4@S91 | **4** (1 + 3 batches) | 9 430 | 3 787 |
| S-5.2@S92 | 2 | 2 677 | 181 |
| S-5.4@S92 | 2 | 2 808 | 522 |
| S-5.2@nonscreen | 2 | 2 476 | 102 |
| S-5.4@nonscreen | 2 | 2 463 | 275 |
| S-6.1 … S-6.5 | 2 each | 13 387 | 1 030 |
| S-7.1 … S-7.4 | 2 each | 13 123 | 589 |
| S-8.1 | 2 | 1 821 | 324 |
| **Total** | **46** | **67 240** | **11 070** |

Batching (`FUNCTION_BATCH_SIZE = 6`): the 15-function screen split **6 + 6 + 3** for both S-5.2 and S-5.4,
batches disjoint and covering every function exactly once; the 2-function screen and the `@nonscreen` round
stayed one call each. Batching does **not** add steps — `51 + 5 × N` is unchanged; it spends extra calls
against the 8-per-step ceiling, so a screen beyond ~42 functions would stop at `CALL_LIMIT`.

Retry rate: **0/46 calls** needed a schema retry (`draftOps` `MAX_SCHEMA_RETRIES = 2`) — expected with a
fixture provider; the number to watch is the `E2E_AI=1` run.

Two op-grammar constraints the engine caught while writing the fixtures, now inlined in the skills:
`functions[].validations` is an array of id-bearing elements so it takes one `add` per element (never a
`set` on the array), and S-7.1 may write only `business_rules`/`assumptions` — the function→rule link is
`business_rules[].source_validation_ids`, not `functions[].business_rule_ids`.

`E2E_AI=1`: **not run** — no provider key in this session. The test is present and skipped by
`it.skipIf(process.env.E2E_AI !== "1")`; DoD line "0 unwaivable red flags, `nfr_missing_number` = 0 on a real
run" is therefore still open.
