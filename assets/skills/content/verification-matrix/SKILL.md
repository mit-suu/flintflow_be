---
skill_id: verification-matrix
kind: content
version: 0.1.0
description: "IEEE 29148 Verification — one verifications[] row per requirement with its method (Mode 1 slot:verification)"
provider: anthropic
aiModel: claude-haiku-5-5
maxTokens: 8192
temperature: 0.2
reads:
  - "verifications[]"
  - "functions[]"
  - "nfrs[]"
  - "business_rules[]"
  - "use_cases[]"
writes:
  - "verifications[]"
  - "assumptions[]"
output_schema: opTransaction
language: en
stub: false
---
# Verification matrix

Covers **Verification** of an ISO/IEC/IEEE 29148 template (jam01 §4) — feeds `slot:verification` (Mode 1 only).
It renders as a matrix: Requirement · Method · Artifact · Status · Evidence. `references/*.md` are **not loaded at
runtime**; rules are inlined.

Shape: `{ id, requirement_id, method: "test" | "analysis" | "inspection" | "demonstration" | "other", artifact?,
status?, evidence? }`.

## Coverage

Every requirement id in the Spine gets **exactly one** row: `functions[]`, `nfrs[]`, `business_rules[]`,
`use_cases[]`. Check the projection first — a requirement that already has a row is updated with `set`, not added
again. A row whose `requirement_id` is not in the Spine is an error (code rule `verification_orphan`): remove it
only when the instruction says the requirement was dropped, otherwise fix the id.

## Choosing the method

| Requirement | `method` |
| --- | --- |
| function, use case | `test` |
| NFR with `metric` and `threshold` (response time, uptime %) | `test` (measured) |
| NFR without a measurable threshold (descriptive) | `inspection` |
| NFR about load / capacity that cannot be run before go-live | `analysis` |
| business rule | `test` |
| compliance with a standard or law (`references[]` normative, "phải tuân") | `inspection` |
| behaviour shown to a stakeholder rather than measured (UI walkthrough the analyst asked for) | `demonstration` |

Keep a method the analyst already chose; change it only when the instruction asks.

## Fields

- `artifact`: suggested test case / review record id — `TC-<requirement id>` for test and demonstration,
  `RV-<requirement id>` for inspection, `AN-<requirement id>` for analysis. Keep an existing artifact.
- `status`: `"not run"` for new rows. Never write "passed" — results come from real testing.
- `evidence`: omit unless the analyst supplied a report or link.

## Rules

1. Ids continue `VER-NN` from the projection (`draft-to-ops` rule 5).
2. `requirement_id` is the Spine id exactly as projected (`FN001`, `N03`, `BR02`, `UC-04`) — not the document's
   display code.
3. Do not edit the requirements themselves; a requirement that cannot be verified as written (vague NFR) gets its
   row with `inspection` plus an `assumptions[]` entry saying what threshold is missing.
4. English for `status` and generated text.

## Example

```json
{
  "ops": [
    { "op": "add", "path": "verifications[]", "value": { "id": "VER-01", "requirement_id": "FN001", "method": "test", "artifact": "TC-FN001", "status": "not run" }, "reason": "function" },
    { "op": "add", "path": "verifications[]", "value": { "id": "VER-02", "requirement_id": "N02", "method": "test", "artifact": "TC-N02", "status": "not run" }, "reason": "NFR with p95 < 2 s threshold" },
    { "op": "add", "path": "verifications[]", "value": { "id": "VER-03", "requirement_id": "N05", "method": "inspection", "artifact": "RV-N05", "status": "not run" }, "reason": "descriptive maintainability NFR" },
    { "op": "add", "path": "assumptions[]", "value": { "id": "AS01", "path": "nfrs[id=N05]", "statement": "N05 is verified by code review only.", "rationale": "N05 has no measurable threshold.", "origin_step_id": "C-4", "status": "unconfirmed", "confirmed_at": null }, "reason": "vague NFR" }
  ],
  "notes": ""
}
```

## Self-check

- [ ] Every function, NFR, business rule and use case has exactly one row.
- [ ] No row points at an id that is not in the Spine.
- [ ] Methods follow the table; no "passed" status.
- [ ] Ids continue the existing `VER-NN` sequence.
