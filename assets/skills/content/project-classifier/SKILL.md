---
skill_id: project-classifier
kind: content
version: 0.2.0
description: "S-1 Analyze & Validate Brief — extraction, project type/domain/complexity, conflicts, gap list"
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 6144
temperature: 0.3
reads:
  - "project"
  - "addendum[]"
  - "assumptions[]"
  - "other_requirements[]"
writes:
  - "project.type"
  - "project.domain"
  - "project.complexity"
  - "assumptions[]"
output_schema: opTransaction
language: en
stub: false
---
# Project Classifier

Covers **S-1.1 Brief Extraction, S-1.2 Project Classification, S-1.3 Conflict & Assumption Review,
S-1.4 Gap List**. This skill never touches SRS sections — its output feeds the classifier fields that
later steps (S-2 NFR thresholds, S-6 non-functional tiers) read from `project`.

Fields this step may write (registry): `project`, `assumptions`. Projection carries `project` (name,
vision, goals, existing type/domain/complexity), `addendum[]`, `assumptions[]`, `other_requirements[]` —
the surrounding `draft-to-ops` prompt already substitutes the actual step id, projection, addendum and
answers around this content; do not restate `{{...}}` placeholders here, they are not interpolated inside
skill content (only in the outer action prompt).

## S-1.2 — Project Classification

Set exactly three scalar fields on `project`, from the Brief and any addendum:

- `project.type` — one line, e.g. `web_application`, `mobile_app`, `api_service`, `desktop_application`.
- `project.domain` — one line business/technical domain, e.g. `Requirements engineering / AI-assisted
  documentation`. Not a taxonomy id — free text, English, no jargon the user did not use.
- `project.complexity` — one of `low`, `medium`, `high`, judged from actor count, integration count and
  stakes (`project.stakes`, already set at B-0.3).

If the Brief already fully determines these three fields (already non-null and consistent with the
addendum), emit `ops: []` and say so in `notes` — do not restate unchanged values as a no-op `set`.

## S-1.3 / S-1.4

S-1.3 resolves conflicts between Brief statements and addendum entries: pick the addendum (newer) unless
it contradicts a user-confirmed assumption, and record the resolution as an `assumptions[]` entry with
`status: "unconfirmed"`. S-1.4 lists what the Brief is missing for SRS (`other_requirements[]` is owned by
a different step; here only `assumptions[]` may be added, flagging the gap for later elicitation).

## Rules

1. Never invent `project.type`/`domain` values not supported by the Brief or addendum — ask instead
   (Coaching) or default + `assumptions[]` entry (Fast), same as `draft-to-ops` rule 10.
2. English for every value (`draft-to-ops` rule 6).
3. One `set` per field — do not wrap the three fields in a single object `set` on `project` (that would
   overwrite sibling fields such as `vision` outside this step's intent).

## Example (S-1.2)

```json
{
  "ops": [
    { "op": "set", "path": "project.type", "value": "web_application", "reason": "Brief describes a browser-only guided workflow" },
    { "op": "set", "path": "project.domain", "value": "Requirements engineering / AI-assisted documentation", "reason": "B-1.1 problem statement" },
    { "op": "set", "path": "project.complexity", "value": "high", "reason": "12-phase pipeline, 5 diagram kinds, credit ledger, multi-role admin" }
  ],
  "notes": "Classification confirmed from Brief; no open questions."
}
```

## Self-check

- [ ] Only `project.type`, `project.domain`, `project.complexity`, `assumptions[]` touched.
- [ ] No field restated with its current value.
- [ ] Every string is English, no diacritics, no section numbers in prose.
- [ ] `assumptions[]` entries (if any) have `origin_step_id` = current `{{step_id}}`.
