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

## Threshold

Ngưỡng chi phí một project do **nhóm đặt** (T22 không tự đặt). `npm run measure:tokens` đọc bảng này và so
kết quả; ô trống hoặc `—` nghĩa là chưa đặt. Điền số (không đơn vị) vào cột Giá trị.

| Chỉ số | Giá trị | Ý nghĩa |
| --- | --- | --- |
| `credit_per_project` | — | Tổng credit một project đi trọn B-0.1 → S-9.5 |
| `usd_per_project` | — | Tổng chi phí provider (USD) một project |
| `tokens_in_per_call` | — | Tokens in tối đa của một lượt gọi model |

<!-- T22:measure-tokens:start -->
## End-to-end token measurement — `spine-fixture-19-screens.json`, mode `estimate` (T22, 2026-09-16)

Sinh bởi `npm run measure:tokens` (`src/scripts/measure-tokens.ts`), 32 s.
Hình fixture: 19 màn, 89 function, 20 vòng S-5 ⇒ `51 + 5 × 20 = 151` step; đo 81 step (bỏ vòng của màn placeholder).
Mỗi step chạy `runStep` thật trên Spine fixture ở trạng thái cuối, mọi step trước đó accepted ⇒ input là **trần** của step.
**Số ước lượng**: tokens_in = ký tự/4 của prompt thật (`getPromptTemplate` + `interpolatePrompt`); tokens_out = ký tự/4 của op-case fixture (không gồm reasoning ẩn — lượt chạy thật M3 đo tokens_out gấp 3–5× tokens_in với GLM-5.3-Flash). Credit theo `getActionCost`.

| Phase | Step | Lượt gọi (elicit + draft) | Tokens in | Tokens out | Credit | USD |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| B-0 | 4 | 8 (4 + 4) | 21 188 | 495 | 20 | n/a |
| B-1 | 6 | 12 (6 + 6) | 33 396 | 992 | 30 | n/a |
| B-2 | 3 | 6 (3 + 3) | 15 562 | 419 | 15 | n/a |
| S-1 | 4 | 8 (4 + 4) | 19 224 | 466 | 20 | n/a |
| S-2 | 5 | 8 (4 + 4) | 15 977 | 906 | 20 | n/a |
| S-3 | 6 | 10 (5 + 5) | 67 473 | 2 136 | 25 | n/a |
| S-4 | 5 | 10 (5 + 5) | 42 340 | 3 050 | 25 | n/a |
| S-5 | 30 | 24 (12 + 12) | 93 210 | 12 471 | 60 | n/a |
| S-6 | 5 | 10 (5 + 5) | 26 779 | 1 065 | 25 | n/a |
| S-7 | 4 | 8 (4 + 4) | 30 488 | 617 | 20 | n/a |
| S-8 | 4 | 2 (1 + 1) | 6 030 | 331 | 5 | n/a |
| S-9 | 5 | 2 (0 + 1) | 10 099 | 7 | 6 | n/a |
| **Tổng** | **81** | **108 (53 + 54)** | **381 766** | **22 955** | **271** | **n/a** |

USD: n/a — chưa truyền `--usd-in`/`--usd-out` (USD / 1M token); provider GLM trên Modal không có bảng giá trong repo.
Step không có op-case fixture (S-9.3, S-9.4) có tokens_out ≈ 0 trong chế độ estimate — chỉ tokens_in của chúng là số dùng được.

### Ngoại suy: mọi vòng S-5 đều chi tiết

Fixture chỉ có 6/20 vòng S-5 chi tiết (màn placeholder bỏ vòng). Nhân trung bình một vòng đã đo lên 20 vòng:

| Kịch bản | Lượt gọi | Tokens in | Tokens out | Credit | USD |
| --- | ---: | ---: | ---: | ---: | ---: |
| Đo được (6 vòng) | 108 | 381 766 | 22 955 | 271 | n/a |
| Ngoại suy (20 vòng) | 164 | 599 256 | 52 054 | 411 | n/a |

### So với ngưỡng (`## Threshold`)

| Chỉ số | Đo được | Ngưỡng | Kết quả |
| --- | ---: | ---: | --- |
| credit_per_project | 271 | chưa đặt | — |
| usd_per_project | n/a | chưa đặt | — |
| tokens_in_per_call (max) | 8 386 | chưa đặt | — |

### Input tăng theo tiến độ?

Tokens in trung bình mỗi step có draft: 1/3 đầu **3 480**, 1/3 cuối **4 393** ⇒ tỉ lệ **1.26×**. < 2× ⇒ projection giữ input phẳng, chưa thấy dấu hiệu bậc hai.


<details><summary>Chi tiết từng step</summary>

| Step | Lượt | Tokens in | Tokens out | Credit | Lỗi |
| --- | ---: | ---: | ---: | ---: | --- |
| B-0.1 | 2 | 5 554 | 286 | 5 | |
| B-0.2 | 2 | 5 212 | 38 | 5 | |
| B-0.3 | 2 | 5 210 | 132 | 5 | |
| B-0.4 | 2 | 5 212 | 39 | 5 | |
| B-1.1 | 2 | 5 568 | 206 | 5 | |
| B-1.2 | 2 | 5 564 | 190 | 5 | |
| B-1.3 | 2 | 5 567 | 102 | 5 | |
| B-1.4 | 2 | 5 564 | 182 | 5 | |
| B-1.5 | 2 | 5 566 | 196 | 5 | |
| B-1.6 | 2 | 5 567 | 116 | 5 | |
| B-2.1 | 2 | 4 790 | 132 | 5 | |
| B-2.2 | 2 | 5 214 | 108 | 5 | |
| B-2.3 | 2 | 5 558 | 179 | 5 | |
| S-1.1 | 2 | 5 025 | 116 | 5 | |
| S-1.2 | 2 | 4 149 | 84 | 5 | |
| S-1.3 | 2 | 5 031 | 92 | 5 | |
| S-1.4 | 2 | 5 019 | 174 | 5 | |
| S-2.1 | 2 | 4 049 | 221 | 5 | |
| S-2.2 | 2 | 3 814 | 231 | 5 | |
| S-2.3 | 2 | 4 543 | 206 | 5 | |
| S-2.4 | 2 | 3 571 | 248 | 5 | |
| S-2.5 | 0 | 0 | 0 | 0 | |
| S-3.1 | 2 | 13 779 | 397 | 5 | |
| S-3.2 | 2 | 13 783 | 873 | 5 | |
| S-3.3 | 2 | 13 787 | 428 | 5 | |
| S-3.4 | 2 | 13 061 | 190 | 5 | |
| S-3.5 | 2 | 13 063 | 248 | 5 | |
| S-3.6 | 0 | 0 | 0 | 0 | |
| S-4.1 | 2 | 15 124 | 1 994 | 5 | |
| S-4.2 | 2 | 7 313 | 117 | 5 | |
| S-4.3 | 2 | 7 495 | 484 | 5 | |
| S-4.4 | 2 | 7 664 | 173 | 5 | |
| S-4.5 | 2 | 4 744 | 282 | 5 | |
| S-5.1@S01 | 0 | 0 | 0 | 0 | |
| S-5.2@S01 | 2 | 7 452 | 513 | 5 | |
| S-5.3@S01 | 0 | 0 | 0 | 0 | |
| S-5.4@S01 | 2 | 7 450 | 1 378 | 5 | |
| S-5.5@S01 | 0 | 0 | 0 | 0 | |
| S-5.1@S05 | 0 | 0 | 0 | 0 | |
| S-5.2@S05 | 2 | 7 524 | 614 | 5 | |
| S-5.3@S05 | 0 | 0 | 0 | 0 | |
| S-5.4@S05 | 2 | 7 522 | 1 652 | 5 | |
| S-5.5@S05 | 0 | 0 | 0 | 0 | |
| S-5.1@S07 | 0 | 0 | 0 | 0 | |
| S-5.2@S07 | 2 | 8 620 | 614 | 5 | |
| S-5.3@S07 | 0 | 0 | 0 | 0 | |
| S-5.4@S07 | 2 | 8 616 | 1 652 | 5 | |
| S-5.5@S07 | 0 | 0 | 0 | 0 | |
| S-5.1@S09 | 0 | 0 | 0 | 0 | |
| S-5.2@S09 | 2 | 7 922 | 513 | 5 | |
| S-5.3@S09 | 0 | 0 | 0 | 0 | |
| S-5.4@S09 | 2 | 7 920 | 1 378 | 5 | |
| S-5.5@S09 | 0 | 0 | 0 | 0 | |
| S-5.1@S10 | 0 | 0 | 0 | 0 | |
| S-5.2@S10 | 2 | 7 488 | 513 | 5 | |
| S-5.3@S10 | 0 | 0 | 0 | 0 | |
| S-5.4@S10 | 2 | 7 486 | 1 378 | 5 | |
| S-5.5@S10 | 0 | 0 | 0 | 0 | |
| S-5.1@nonscreen | 0 | 0 | 0 | 0 | |
| S-5.2@nonscreen | 2 | 7 606 | 614 | 5 | |
| S-5.3@nonscreen | 0 | 0 | 0 | 0 | |
| S-5.4@nonscreen | 2 | 7 604 | 1 652 | 5 | |
| S-5.5@nonscreen | 0 | 0 | 0 | 0 | |
| S-6.1 | 2 | 5 338 | 279 | 5 | |
| S-6.2 | 2 | 5 333 | 202 | 5 | |
| S-6.3 | 2 | 5 432 | 225 | 5 | |
| S-6.4 | 2 | 5 334 | 229 | 5 | |
| S-6.5 | 2 | 5 342 | 130 | 5 | |
| S-7.1 | 2 | 12 226 | 120 | 5 | |
| S-7.2 | 2 | 4 091 | 229 | 5 | |
| S-7.3 | 2 | 10 044 | 131 | 5 | |
| S-7.4 | 2 | 4 127 | 137 | 5 | |
| S-8.1 | 2 | 6 030 | 331 | 5 | |
| S-8.2 | 0 | 0 | 0 | 0 | |
| S-8.3 | 0 | 0 | 0 | 0 | |
| S-8.4 | 0 | 0 | 0 | 0 | |
| S-9.1 | 0 | 0 | 0 | 0 | |
| S-9.2 | 0 | 0 | 0 | 0 | |
| S-9.3 | 1 | 4 500 | 4 | 2 | |
| S-9.4 | 1 | 5 599 | 3 | 4 | |
| S-9.5 | 0 | 0 | 0 | 0 | |

</details>
<!-- T22:measure-tokens:end -->

## M4 — một project mới đi trọn B-0.1 → S-9.5 với provider thật (2026-09-16)

Mốc **M4** của `claude_plan/plan-overview.md` §5, hoãn từ Wave 4, chạy sau khi T22 xong.

Cách chạy: `npm run run:pipeline -- --waive-blocking` (`src/scripts/run-full-pipeline.ts`, T24) trên BE dev
(`:5000`) + Mongo thật + PlantUML thật, provider **thật** (`glm` / GLM-5.3-Flash trên Modal, `reasoning_effort:
"low"`). Script tự đăng nhập → tạo project → mỗi step `POST /run` (SSE) → trả lời `answer_needed` → `POST /gate
accept` → `POST /assemble` → `GET /export/word` → `POST /baseline`. **Không** dùng fixture op-case, **không**
mock, **không** ghi thẳng vào Spine.

Sản phẩm dùng để chạy: **MediQueue** — đặt lịch khám và quản lý hàng chờ cho chuỗi phòng khám đa khoa
(Brief nằm trong chính script, cố ý không phải FlintFlow để model không chép lại ví dụ có sẵn trong skill).
Mọi câu hỏi Elicit được trả lời tự động: lượt đầu nhận trọn Brief, các lượt sau nhận một câu hướng dẫn
"dùng Brief + tài liệu đã có, thiếu thì tự chọn rồi ghi thành assumption".

### Kết quả

| | |
| --- | --- |
| Step accepted | **66 / 81** (15 step còn lại là vòng S-5 của 3 màn `placeholder`, `nextStep` bỏ qua) |
| Lượt gọi model | **72** (48 step có gọi; 2 lượt bị refund) |
| Tokens in / out | **292 572 / 46 629** |
| Credit | **225** |
| Retry schema | **3 / 74** lượt gọi (`attempt > 1`) |
| Tokens in lớn nhất một lượt | **7 220** |
| Thời gian mỗi step | 1–75 s (step không gọi model 1–6 s) |
| Assemble | 33 section |
| Word | 93 KB |
| Baseline | **`v1.0-conditional`**, 59 cờ được waive |

| Phase | Step có gọi model | Lượt gọi | Tokens in | Tokens out | Credit |
| --- | ---: | ---: | ---: | ---: | ---: |
| B-0 | 4 | 6 | 16 566 | 2 918 | 18 |
| B-1 | 6 | 9 | 37 846 | 7 415 | 30 |
| B-2 | 3 | 6 | 30 853 | 2 610 | 18 |
| S-1 | 4 | 6 | 31 071 | 2 526 | 18 |
| S-2 | 4 | 6 | 17 125 | 1 227 | 18 |
| S-3 | 5 | 7 | 26 868 | 5 244 | 22 |
| S-4 | 5 | 7 | 23 599 | 7 109 | 22 |
| S-5 | 6 | 9 | 41 771 | 6 242 | 30 |
| S-6 | 5 | 7 | 27 771 | 4 381 | 22 |
| S-7 | 4 | 6 | 26 062 | 3 977 | 18 |
| S-8 | 1 | 2 | 7 361 | 1 218 | 5 |
| S-9 | 1 | 1 | 5 679 | 1 762 | 4 |
| **Tổng** | **48** | **72** | **292 572** | **46 629** | **225** |

### Nội dung sinh ra

5 màn (2 chi tiết, 3 `placeholder`) · 11 function · 3 actor · 11 use case · 6 entity · 19 NFR ·
9 business rule · 4 mục glossary · 57 assumption. **6/6 diagram `render_status: "ok"`**
(context, use case, ERD, screen flow, authorization, sequence).

### Cờ lúc ký baseline

`POST /baseline` **bị chặn đúng như thiết kế** (`422 BASELINE_BLOCKED`) rồi mới ký được sau khi waive:

| Số | Mức | Luật |
| ---: | --- | --- |
| 55 | đỏ | `unconfirmed_assumption` |
| 17 | đỏ | `section_empty` |
| 11 | đỏ | `array_empty` |
| 4 | đỏ | `section_stale_at_baseline` |
| 2 | đỏ | `nfr_missing_number` |
| 11 | vàng | `usecase_no_function` |
| 2 | vàng | `goal_not_covered` |
| 1 | vàng | `role_no_actor` |

**55 cờ `unconfirmed_assumption` là hệ quả của cách trả lời tự động, không phải lỗi sản phẩm**: script
luôn bảo model "thiếu thì tự chọn rồi ghi thành assumption", và B-2.1 (Assumption Sweep) được accept mà
không xác nhận cái nào. Người dùng thật trả lời B-2.1 sẽ đóng phần lớn số này. `section_empty` /
`array_empty` rơi vào các section của màn `placeholder` và phụ lục chưa có nội dung — đúng hình của một
project đi nhanh.

### Điều học được

- **Một project đi trọn tốn ~225 credit / ~293k token in / ~47k token out.** So với ngoại suy của
  `measure:tokens` (411 credit cho fixture 19 màn, 20 vòng S-5) thì con số này hợp lý: project M4 chỉ có
  5 màn và 2 vòng S-5 chi tiết.
- **Projection giữ input phẳng.** Lượt gọi nặng nhất 7 220 token in, và phase cuối (S-7, S-9) không cao
  hơn phase đầu — không có dấu hiệu tăng bậc hai theo tiến độ, đúng như `measure:tokens` đo trên fixture.
- **Độ tin cậy schema tốt**: 3/74 lượt gọi phải retry, không lượt nào chạm trần `MAX_SCHEMA_RETRIES`.
- **Hai lỗi thật lộ ra trong lượt chạy này**, cả hai đã sửa trong T24:
  1. `B-2.3` đọc `assumptions[status=unconfirmed]` (mảng đã **lọc**), nên các assumption vừa được B-2.1
     xác nhận biến mất khỏi projection và model đặt trùng id (`AS10 đã tồn tại`, hỏng 3/3 lượt →
     `NEEDS_USER_INPUT`). Sửa ở `context-projection.ts`: chỉ bỏ qua việc thêm danh sách id khi step đọc
     **trọn** `assumptions`.
  2. `progress.current_step` chỉ được ghi lúc `/run` bắt đầu, không phải lúc gate accept — chạy tiếp một
     project dở theo con trỏ đó sẽ gặp `STEP_NOT_RUNNABLE`. Script tự tính step tới lượt theo đúng luật
     `nextStep()`; xem `docs/spec-gaps.md`.
- Model dùng **hai kiểu id function trong cùng một project** (`FN01` rồi `FN002`). Không vi phạm bất biến
  nào (id chỉ cần duy nhất) nhưng nhìn lệch trong tài liệu — ghi vào `docs/spec-gaps.md`.

## FLF-171 P2 — Mode 1 import + change request, provider thật (2026-09-18)

- Tài liệu: SRS Report3 của nhóm (`doc/Report3_Software Requirement Specification.docx.md` chuyển sang .docx bằng thư viện `docx`, bỏ ảnh nhúng): 1 903 block ở mức md ⇒ 3 450 block sau tách, 201 heading, 9 bảng khớp cột tất định.
- Provider: `glm` / `zai-org/GLM-5.3-Flash` (Modal), Mongo in-memory replica set, luồng HTTP thật (`/import` → `/confirm-latest` → `/mapping confirm_all` → `/extract` → `/fields confirm_all` → `/finalize` → `/gap-report`, rồi 1 CR `clarify → impact → propose → verify`).
- Kết quả: 98 section trích xong, 0 section lỗi; Spine: 4 actor, 81 UC, 13 feature, 70 function, 150 màn, 15 entity, 41 NFR, 36 BR, 100 message. Cờ: 0 đỏ, 169 vàng; gap report: 1 section thiếu, 5 heading không khớp, 50 field độ tin thấp. Tổng 397 s.

| Bước | Lượt gọi | tokens_in | tokens_out | Credit |
|---|---:|---:|---:|---:|
| I-4 trích field | 77 | 363 077 | 41 988 | 154 |
| 1.11 AI semantic check | 1 | 10 426 | 1 249 | 3 |
| C-2 làm rõ CR | 1 | 3 789 | 117 | 1 |
| C-4 đề xuất (80 vị trí, 10 lô) | 10 | 22 521 | 5 744 | 30 |
| C-5 consistency | 1 | 1 493 | 992 | 2 |

Nhận xét:
- Output theo thực thể (P0 §4.8) giữ tokens_out ≈ 12% tokens_in (P0 ước tính output phình 0,4–3× nếu theo path).
- Import một SRS đầy đủ tốn **157 credit** — vẫn vượt 100 credit gói free. Hướng giảm: gộp section nhỏ vào cùng một lượt (hiện một lượt/section, 77 lượt cho 98 section), trích tất định thêm bảng dọc (đặc tả UC/function dạng "nhãn | giá trị").
- Lượt chạy đầu phát hiện một section gửi ~2,9 triệu token (ảnh base64 nằm trong text) ⇒ đã thêm trần 24k ký tự/lượt và 6k ký tự/block (`extract.service.ts#chunkBlocks`).
- C-3 chạm trần 80 vị trí với CR "session timeout" (từ khoá rộng) ⇒ C-4 tốn 30 credit, phần lớn kết luận `not_related`.
- `/import/extract` chạy đồng bộ ~5,6 phút trong một request trên SRS đầy đủ.

## Mode 1 v3 phase 5 — đọc ảnh diagram bằng Gemini (2026-09-22)

- Ảnh: 91 PNG nhúng trong SRS Report3 của nhóm (`doc/Report3_Software Requirement Specification.docx.md`), chọn ảnh dưới mục diagram (Product Overview, 2.2.1, Figure 03–12 use case, 3.1.1 luồng màn, 3.1.5 ERD) + 1 ảnh layout màn hình làm đối chứng.
- Cách đo: prompt dựng từ skill thật `import-extract-diagram` (`interpolatePrompt`), gọi `callLLM` provider `gemini` / `gemini-3.5-flash` kèm một ảnh, parse bằng `importExtractDiagramSchema` — không qua Mongo/credit.

| Loại (model phân) | Lượt OK | tokens_in / lượt | tokens_out / lượt | Thực thể đọc được / ảnh |
|---|---:|---:|---:|---|
| `context` (Product Overview) | 1 | 2 202 | 823 | 6 actor |
| `usecase` (Figure 03–12, 2.2.1) | 10 | 2 224–2 274 | 359–2 606 | 1–2 actor, 2–19 UC |
| `other` (layout màn Forgot password) | 1 | 2 217 | 46 | 0 (giữ ảnh gốc) |

Nhận xét:
- tokens_in gần như cố định ~2,2k/ảnh (ảnh ~1,9k + prompt) ⇒ giá **2 credit/ảnh** (`IMPORT_EXTRACT_DIAGRAM`) ngang một lô chữ I-4. Chỉ gửi ảnh ở mục diagram (`DIAGRAM_SECTIONS`); ảnh chụp màn hình dưới mô tả màn / chức năng không gửi (Report3: ~75/91 ảnh) ⇒ một SRS cỡ Report3 tốn ~15 lượt ảnh ≈ 30 credit.
- Phân loại đúng cả 12 lượt (context / use case / other). Ảnh use case lớn (19 UC) trả 2,6k token ⇒ `maxTokens` 4096 bị cắt một lần (`RESPONSE_TRUNCATED`) ⇒ nâng lên **8192**.
- Thời gian 14–24 s/ảnh; Gemini trả 503 "high demand" nhiều lần (retry trong request của `executeAiAction` gánh), rồi **hết quota ngày của key free tier** sau ~20 lượt ⇒ lượt lỗi thành `paused: resume_later` ở I-4 (chạy tiếp được). Môi trường thật cần key trả phí.
- Chưa đo được `erd` (3.1.5) và `screen_flow` (3.1.1) do hết quota — đo lại khi có key khác.
