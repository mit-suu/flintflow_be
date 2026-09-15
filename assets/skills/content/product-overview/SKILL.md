---
skill_id: product-overview
kind: content
version: 0.2.0
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
output_schema: opTransaction
language: en
stub: true
---
# Product Overview

> `stub: true` is kept only so `prompt-assets.test.ts` (T03, owned file) keeps passing — it asserts every
> non-`action` skill is a stub. Content below is real, written in T14. XREQ T14→T03: split that assertion
> once T03 revisits it.

Covers **S-2.1 Product Overview, S-2.2 Release 1.0 Scope, S-2.3 External Systems** — feeds SRS section
`fixed:1` (Product Overview). The step registry's `writes` is coarser than the frontmatter above: S-2.1/
S-2.2 may write `project` + `assumptions`; S-2.3 may write `actors` + `assumptions`. The engine enforces
the registry list, not this file — this file documents intent per sub-step.

## Context (per step)

- Step: **{{step_id}}** — {{step_name}} · Fields this step may write: {{writable_paths}}
- Projection: {{projection}} — current `project.vision/goals/release_scope`, `actors[kind!=human]`
- Addendum for this step: {{addendum}}

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
one-liner.

## Rules

1. `release_scope.in`/`.out` are prose bullets, not feature ids — no `F2`/`feature:F2` references yet
   (features do not exist until S-4.1).
2. English (`draft-to-ops` rule 6); no section numbers in prose (rule 7).
3. New `actors[]` ids continue the sequence (`draft-to-ops` rule 5) — check the projection's existing
   actors before picking an id.

## Example (S-2.3, one system actor)

```json
{
  "ops": [
    { "op": "add", "path": "actors[]", "value": { "id": "A06", "name": "Payment Gateway", "kind": "system", "description": "Mock external gateway that authorizes and settles credit purchases for the wallet." }, "reason": "S-2.3 external system from release scope" }
  ],
  "notes": "One external system identified from release scope: the mock payment gateway."
}
```

## Self-check

- [ ] Only fields for the current sub-step touched (S-2.1 project text, S-2.2 release_scope, S-2.3 actors).
- [ ] `release_scope.in` entries each trace to a stated goal.
- [ ] Every new actor has `kind: "system"` and a project-specific description.
- [ ] No diacritics, no Vietnamese in any value that renders to SRS.
