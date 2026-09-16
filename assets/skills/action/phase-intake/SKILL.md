---
skill_id: phase-intake
kind: action
version: 1.0.0
description: Build the Spine projection for a phase, list empty fields, collect relevant addendum entries
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 1024
temperature: 0
reads:
  - project
  - progress
  - addendum[]
  - assumptions[]
  - "<phase projection: srs-spine §4>"
writes: []
output_schema: none
language: en
---

# Phase Intake

Deterministic contract, run **once at the start of each phase** by the step runner. **No model call.** Its output is the input of `elicit-loop` and `draft-to-ops`.

## Why a projection

Context is a **projection, never the whole Spine** (Phases §3). Loading the full Spine makes input cost grow with progress, so total cost becomes quadratic in the number of steps. Loading the full transcript is forbidden for the same reason.

## Inputs

- `phase_id` (`B-0` … `S-9`) and, for S-5, the current `screen_id`.
- The step list of the phase (`srs-orchestrator/references/step-table.md`).

## Procedure

1. **Collect fields** for every step in the phase: the union of the columns *Owns*, *Reads* and *Derives* for the sections those steps feed (`references/projection-map.md`).
2. **Project** the Spine to those paths only. Arrays are filtered by key, not by index:
   - S-5 round for screen `S3` → `screens[id=S3]`, `functions[screen_id=S3]`, the feature of `S3`, `roles[]`, `permissions[screen_id=S3]`, `business_rules[tier=detail]`.
   - S-5 non-screen round → `functions[screen_id=null]`.
3. **List empty fields** — a field is empty when it is missing, `null`, `""` or `[]`. Report them as Spine paths (`project.release_scope.out`, `nfrs[category=performance]`).
4. **Collect addendum** — `addendum[]` whose `target_section` is a section fed by this phase. Use `content_en` for the model; keep `content` verbatim for the user.
5. **Collect open assumptions** — `assumptions[status=unconfirmed]` whose `path` falls inside the projection.
6. **Load the Brief slice** the phase depends on (Phases §6.1 column "Input from Brief").

## Output (to the step runner)

```json
{
  "phase_id": "S-3",
  "spine_version": 42,
  "projection": { "actors": [], "roles": [], "use_cases": [] },
  "missing": ["use_cases[]", "roles[].actor_id"],
  "addendum": [{ "id": "AD4", "target_section": "fixed:2.1", "content_en": "..." }],
  "assumptions": [{ "id": "AS2", "path": "actors[id=A02]", "statement": "..." }]
}
```

`spine_version` is carried as `base_version` for every transaction drafted in this phase.

## Rules

- **Ask only what is missing** (Phases §0.7). If `missing` is empty and there are no unconfirmed assumptions, the orchestrator may skip Elicit for the phase.
- A field already filled by the Brief or by a cloned project is **not** missing — never re-ask it.
- Keys only: never resolve `actors[1]`; always `actors[id=A02]`.
- Do not include internal state that never renders (`usage[]`, `baselines[]`, `sessions[]`) in the projection sent to a model.
- Uploaded documents enter only as `extractedText`/summary, never the file (Phases §4.3).
