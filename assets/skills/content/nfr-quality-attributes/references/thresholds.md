# Default NFR thresholds

> Human-facing reference. **Not loaded at runtime** — the table the model uses is inlined in `../SKILL.md`.

## How the defaults are chosen

Two Spine fields decide the column: `project.stakes` (`internal` | `production` | `regulated`) and
`project.complexity` (`low` | `medium` | `high`). They are set at S-1.2 by `project-classifier`.

The point of a default is not to be right; it is to make the number **visible and arguable**. Every
default the model takes instead of a stated figure must land in `assumptions[]` with
`status: "unconfirmed"`, so S-9.2 surfaces it before baseline and a reviewer can overrule it in one edit.

## Reliability

| Metric | internal / low | production / medium | production / high | regulated |
| --- | --- | --- | --- | --- |
| Monthly uptime | >= 99.0 % | >= 99.5 % | >= 99.9 % | >= 99.95 % |
| Recovery time (RTO) | <= 8 h | <= 4 h | <= 1 h | <= 30 min |
| Data loss window (RPO) | <= 24 h | <= 4 h | <= 15 min | <= 5 min |
| Failed-request rate | <= 2 % | <= 1 % | <= 0.5 % | <= 0.1 % |
| Backup verification | monthly | weekly | weekly | daily |

## Performance

| Metric | internal / low | production / medium | production / high |
| --- | --- | --- | --- |
| p95 response time (interactive) | <= 3 s | <= 2 s | <= 1 s |
| p99 response time (interactive) | <= 6 s | <= 4 s | <= 2 s |
| p95 latency (long-running job) | <= 5 min | <= 2 min | <= 60 s |
| Concurrent users | >= 50 | >= 500 | >= 5000 |
| Throughput (writes/min) | >= 30 | >= 300 | >= 1000 |

**Never fold a long-running job into the interactive budget.** An AI generation step or a document render
is seconds-to-minutes work; holding it to a 1 s p95 produces a requirement nobody can meet and everybody
ignores, which is worse than no requirement.

## Usability

Usually descriptive, but these are worth quantifying when the domain allows:

| Metric | Typical default |
| --- | --- |
| Accessibility conformance | WCAG 2.1 AA |
| Supported viewport width | >= 360 px |
| Time for a new user to finish the primary task unaided | <= 10 min |
| Supported languages | the product's own UI language(s), listed explicitly |

## Domain-specific (`other`)

| Metric | When it applies | Typical default |
| --- | --- | --- |
| Audit log retention | any product with destructive admin actions | 12 months |
| Personal data retention after deletion request | any product holding personal data | <= 30 days |
| Encryption at rest / in transit | production and above | AES-256 / TLS 1.2+ |
| Secret rotation interval | production and above | 90 days |
| Cost ceiling per AI-assisted action | products that resell model calls | stated in credits, from the pricing model |

## Sources

Product-Brief-to-SRS-Phases.md §6.4 (S-6.1…S-6.5) and §7.2; the `nfr_missing_number` red rule in
`src/modules/spine/deterministic-check.ts` is what enforces "reliability and performance carry a number".
