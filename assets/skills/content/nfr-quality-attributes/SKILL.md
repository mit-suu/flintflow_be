---
skill_id: nfr-quality-attributes
kind: content
version: 0.3.0
description: "S-6.1-6.5 external interfaces and quality attributes; reliability and performance carry a metric and a threshold"
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 6144
temperature: 0.3
reads:
  - "project"
  - "nfrs[]"
  - "actors[]"
writes:
  - "nfrs[]"
  - "assumptions[]"
output_schema: opTransaction
language: en
stub: false
---
# NFR And Quality Attributes

Covers **S-6.1 External Interfaces, S-6.2 Usability, S-6.3 Reliability, S-6.4 Performance,
S-6.5 Domain-Specific Attributes** — feeds `fixed:4.1` and `fixed:4.2.1`…`fixed:4.2.4`. One step writes
one category, so only emit rows for the category named by the current step.
`references/thresholds.md` is **not loaded at runtime**; the default table is inlined below.

Shape: `{id, category, statement, kind, metric?, threshold?, priority: null}` where `category` is
`interface` | `usability` | `reliability` | `performance` | `other`, and `kind` is `quantitative`
(has `metric` + `threshold`) or `descriptive`.

**The rule the deterministic check enforces: every `reliability` and `performance` row must be
`kind: "quantitative"` with a non-empty `metric` AND `threshold`.** A row without them opens the red flag
`nfr_missing_number`, which blocks the baseline. "The system should be fast" is not a requirement.

## S-6.1 — External interfaces (`category: "interface"`)

One row per boundary the product talks across. Sweep: every `actors[kind=system]` (payment gateway, AI
provider, mail, storage, identity provider); the user-facing client (browser/mobile, per
`project.form_factor`); file formats consumed or produced (upload types, `.docx` export); and any
inbound API we expose. `statement` names the counterpart, the direction and the shape of exchange —
"The system exchanges JSON over HTTPS with the payment gateway and accepts signed webhook callbacks."
These are usually `descriptive`; make one quantitative when a contract exists (a rate limit, an SLA).

## S-6.2 — Usability (`category: "usability"`)

Accessibility level, language/localisation, input device and screen size range, learnability, and how
errors are surfaced. Prefer a checkable statement over an adjective: "Every screen meets WCAG 2.1 AA for
contrast and keyboard navigation" beats "the UI is easy to use". `descriptive` is acceptable here, but a
row that cannot be checked by a reviewer is not a requirement — rewrite it.

## S-6.3 — Reliability, S-6.4 — Performance (quantitative, always)

Pick `metric` and `threshold` from the defaults below, scaled by `project.stakes` × `project.complexity`,
unless the Brief states a number. Both fields are short strings: `metric: "p95 response time"`,
`threshold: "<= 2 s"`.

| Category | Metric | internal / low | production / medium | production / high |
| --- | --- | --- | --- | --- |
| reliability | Monthly uptime | >= 99.0 % | >= 99.5 % | >= 99.9 % |
| reliability | Recovery time (RTO) | <= 8 h | <= 4 h | <= 1 h |
| reliability | Data loss window (RPO) | <= 24 h | <= 4 h | <= 15 min |
| reliability | Failed-request rate | <= 2 % | <= 1 % | <= 0.5 % |
| performance | p95 response time (interactive) | <= 3 s | <= 2 s | <= 1 s |
| performance | p95 latency (long-running job) | <= 5 min | <= 2 min | <= 60 s |
| performance | Concurrent users supported | >= 50 | >= 500 | >= 5000 |
| performance | Throughput (writes/min) | >= 30 | >= 300 | >= 1000 |

Take at least three rows per category. A long-running AI or render step gets its own performance row —
do not fold it into the interactive budget, the numbers differ by two orders of magnitude. Any number
you chose from this table rather than from the Brief gets an `assumptions[]` entry
(`status: "unconfirmed"`) pointing at the `nfrs[]` row.

## S-6.5 — Domain-specific (`category: "other"`)

Only what this domain forces: security/authn-authz posture, privacy and data residency, retention,
auditability, regulatory regime, portability, cost ceilings. Skip the category honestly (`ops: []` plus a
`notes` line) rather than padding it with generic security boilerplate. Quantify where the domain does:
retention periods, key rotation intervals, audit-log horizons.

## Rules

1. Only the category of the current step; ids continue the existing sequence (`draft-to-ops` rule 5).
2. `priority` stays `null` — MoSCoW is assigned at S-9.4.
3. `metric`/`threshold` are omitted entirely for `descriptive` rows, never set to `""`.
4. One requirement per row: "fast and always available" is two rows.
5. English values, no diacritics, no section numbers in prose (`draft-to-ops` rules 6–7).
6. Fast mode: take the table default plus an `assumptions[]` entry; Coaching mode leaves the number for
   Elicit (`draft-to-ops` rule 10).

## Example (S-6.4, production × high)

```json
{
  "ops": [
    { "op": "add", "path": "nfrs[]", "value": { "id": "N12", "category": "performance", "statement": "Interactive screens respond within the stated budget under normal load.", "kind": "quantitative", "metric": "p95 response time", "threshold": "<= 1 s", "priority": null }, "reason": "S-6.4 interactive budget" },
    { "op": "add", "path": "nfrs[]", "value": { "id": "N13", "category": "performance", "statement": "A guided generation step completes within the stated budget.", "kind": "quantitative", "metric": "p95 step completion time", "threshold": "<= 60 s", "priority": null }, "reason": "S-6.4 long-running job budget" },
    { "op": "add", "path": "assumptions[]", "value": { "id": "AS21", "path": "nfrs[id=N13].threshold", "statement": "60 s p95 for a generation step is the default for production stakes and high complexity.", "rationale": "The Brief states no performance target.", "origin_step_id": "S-6.4", "status": "unconfirmed", "confirmed_at": null }, "reason": "S-6.4 default threshold" }
  ],
  "notes": "Throughput row added as N14; concurrency taken from the release scope."
}
```

## Self-check

- [ ] Rows belong only to the current step's category.
- [ ] Every `reliability`/`performance` row is `quantitative` with non-empty `metric` and `threshold`.
- [ ] At least three rows each for reliability and performance, including one long-running-job budget.
- [ ] Every `actors[kind=system]` appears in an `interface` row.
- [ ] Every threshold taken from the default table has an `assumptions[]` entry.
- [ ] `priority` is `null` everywhere; one requirement per row.
