---
skill_id: requirement-apportioning
kind: content
version: 0.1.0
description: "IEEE 29148 Apportioning of requirements — set functions[].release / nfrs[].release per release (Mode 1 slot:apportioning)"
provider: anthropic
aiModel: claude-haiku-5-5
maxTokens: 6144
temperature: 0.2
reads:
  - "project"
  - "functions[]"
  - "nfrs[]"
  - "addendum[]"
writes:
  - "functions[]"
  - "nfrs[]"
  - "assumptions[]"
output_schema: opTransaction
language: en
stub: false
---
# Requirement apportioning

Covers **Apportioning of Requirements** of an ISO/IEC/IEEE 29148 / IEEE 830 template (§2.6) — feeds
`slot:apportioning` (Mode 1 only). The section renders as a table: one row per requirement, one column per release,
plus a "Deferred" column. Assign a release to **every** `functions[]` and `nfrs[]` row by `set`-ing its `release`
field. `references/*.md` are **not loaded at runtime**; rules are inlined.

## Sources

- `project.release_scope.in` / `.out` — what the current release covers and what it explicitly leaves out.
- `functions[].priority`, `nfrs[].priority` (MoSCoW from S-9.4) — read only.
- Release milestones the analyst gave (`addendum[]`, the instruction, attached documents), e.g. "1.1 in March".
- The template's guidance for this section, if any (`Template guidance:` in the target sections).

## Default mapping

| Signal | `release` |
| --- | --- |
| priority `must` / `should`, and not in `release_scope.out` | current release (default `"1.0"`, or the version the project names) |
| priority `could` | next release (`"1.1"`, or the next milestone the analyst named) |
| priority `wont`, or the function / NFR is listed in `release_scope.out` | `"deferred"` |
| priority `null` | current release, plus one `assumptions[]` entry listing those ids |

An explicit milestone from the analyst beats the default ("export goes in 1.2" ⇒ `"1.2"` even if priority is
`should`).

## Rules

1. Write only `release` — never change `priority` (that belongs to `prioritization`, S-9.4) and never edit names,
   statements or ids.
2. Every function and NFR ends with a non-null `release`; skip none. Use `set` on `functions[id=…].release` /
   `nfrs[id=…].release`.
3. Release labels are short version strings (`"1.0"`, `"1.1"`, `"2.0"`) or exactly `"deferred"` — no dates, no
   sentences. Reuse labels already present in the Spine instead of inventing a parallel scheme.
4. When `release_scope` and priority disagree (a `must` listed in `out`), follow `release_scope` and add one
   `assumptions[]` entry naming the conflict.
5. Do not create new functions or NFRs to fill a release.

## Example

```json
{
  "ops": [
    { "op": "set", "path": "functions[id=FN001].release", "value": "1.0", "reason": "must, in release_scope.in" },
    { "op": "set", "path": "functions[id=FN014].release", "value": "1.1", "reason": "could — next release" },
    { "op": "set", "path": "functions[id=FN020].release", "value": "deferred", "reason": "listed in release_scope.out" },
    { "op": "set", "path": "nfrs[id=N03].release", "value": "1.0", "reason": "should, applies to the current release" },
    { "op": "add", "path": "assumptions[]", "value": { "id": "AS01", "path": "functions[id=FN031].release", "statement": "FN031 is apportioned to release 1.0 by default.", "rationale": "FN031 has no priority.", "origin_step_id": "C-4", "status": "unconfirmed", "confirmed_at": null }, "reason": "priority null" }
  ],
  "notes": ""
}
```

## Self-check

- [ ] Every function and every NFR has a `release`.
- [ ] `wont` and `release_scope.out` items are `"deferred"`; nothing else is.
- [ ] No `priority` or text field touched.
- [ ] Release labels form one consistent scheme.
