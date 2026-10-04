---
skill_id: product-overview
kind: content
version: 0.4.0
description: "S-2.1–S-2.3 Product Overview, Release 1.0 scope, external systems"
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 6144
temperature: 0.3
reads:
  - "project.name"
  - "project.vision"
  - "project.goals[]"
  - "addendum[]"
writes:
  - "project.vision"
  - "project.goals[]"
  - "project.release_scope"
  - "actors[kind≠human]"
  - "assumptions[]"
output_schema: opTransaction
language: en
stub: false
---
# Product Overview

Covers **S-2.1 Product Overview, S-2.2 Release 1.0 Scope, S-2.3 External Systems** — feeds SRS section
`fixed:1` (Product Overview). The step registry's `writes` is coarser than the frontmatter above: S-2.1/
S-2.2 may write `project` + `assumptions`; S-2.3 may write `actors` + `assumptions`. The engine enforces
the registry list, not this file — this file documents intent per sub-step.

Projection carries current `project.vision/goals/release_scope`, `actors[kind!=human]` — the surrounding
`draft-to-ops` prompt already substitutes the actual step id, writable paths, projection and addendum
around this content; do not restate `{{...}}` placeholders here, they are not interpolated inside skill
content (only in the outer action prompt).

## S-2.1 — Product Overview

Write `project.vision` (one paragraph: problem, target user, why now) and `project.goals[]` (3–6 bullet
outcomes) from the Brief (B-1.1, B-1.3) and addendum. If the Brief already carries a complete vision and
goals, emit `ops: []` — do not paraphrase a value that is already correct.

## S-2.2 — Release 1.0 Scope

Write `project.release_scope.in` and `.out` as flat string lists — each entry one capability, no nesting.
`in` must trace to a goal from S-2.1; `out` records deliberate exclusions the Brief or addendum names
(B-1.4). Use `set` on the whole `release_scope` object (it has no id, it is a singleton).

## S-2.3 — External Systems

Add one `actors[]` entry per external system the product integrates with (payment gateway, render
server, third-party auth…) with `kind: "system"`. Do **not** add human actors here — those belong to
S-3.1. Every system actor needs a `description` stating what it does for this product, not a generic
one-liner. Derive integrations from vision/goals/scope even when the Brief does not name a vendor: AI
generation ⇒ "AI Model Provider"; credits/payments/plans ⇒ "Payment Gateway"; export/email/notification ⇒
the matching service. Add them with an `assumptions[]` entry; an empty S-2.3 batch needs a reason
in `notes`.

For S-2.3 only, every added or updated system actor must have non-empty `flows_in` and `flows_out` for
the Context Diagram. Directions are relative to OUR system: `flows_out` = requests/data our system sends
to the external actor; `flows_in` = results/data that actor returns. List every required exchange in
English noun phrases, exactly one exchange per array item: both lists have equal length, and `flows_in[i]`
pairs with `flows_out[i]`. Each item becomes its own arrow with one label; never combine exchanges in one item.
For a payment gateway: `flows_out: ["Payment request"]`, `flows_in: ["Payment result"]`; for an email
service: `flows_out: ["Email delivery request"]`, `flows_in: ["Email delivery status"]`. Do not use
use-case verbs or omit exchanges behind `+ N more`. Preserve confirmed exchanges when updating actors;
repair an existing actor with a missing list. Derive labels from the Brief/scope/description; uncertain
exchange details need an `assumptions[]` entry rather than an invented confirmed requirement.

## Rules

1. `release_scope.in`/`.out` are prose bullets, not feature ids — no `F2`/`feature:F2` references yet
   (features do not exist until S-4.1).
2. English (`draft-to-ops` rule 6); no section numbers in prose (rule 7).
3. New `actors[]` ids continue the sequence (`draft-to-ops` rule 5) — check the projection's existing
   actors before picking an id.
4. Fill a missing vision/goal/scope detail with the most reasonable default and add an
   `assumptions[]` entry (`status: "unconfirmed"`) instead of leaving it blank (`draft-to-ops` rule 10).

## Example (S-2.3, one system actor)

```json
{
  "ops": [
    { "op": "add", "path": "actors[]", "value": { "id": "A01", "name": "Payment Gateway", "kind": "system", "description": "Mock external gateway that authorizes and settles credit purchases for the wallet.", "flows_in": ["Payment result"], "flows_out": ["Payment request"] }, "reason": "S-2.3 external system and its request/result exchange from release scope" }
  ],
  "notes": "One external system identified from release scope: the mock payment gateway."
}
```

## Self-check

- [ ] Only fields for the current sub-step touched (S-2.1 project text, S-2.2 release_scope, S-2.3 actors).
- [ ] `release_scope.in` entries each trace to a stated goal.
- [ ] Every new actor has `kind: "system"` and a project-specific description.
- [ ] S-2.3 actors have equal-length `flows_in`/`flows_out`; each item has exactly one exchange and a paired result/status at the same index.
- [ ] No diacritics, no Vietnamese in any value that renders to SRS.
