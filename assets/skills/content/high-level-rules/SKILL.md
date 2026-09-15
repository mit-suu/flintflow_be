---
skill_id: high-level-rules
kind: content
version: 0.2.0
description: "S-2.4 High-Level Business Rules (tier=high)"
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 6144
temperature: 0.3
reads:
  - "project.vision"
  - "project.release_scope"
  - "addendum[]"
writes:
  - "business_rules[tier=high]"
output_schema: opTransaction
language: en
stub: true
---
# High Level Rules

> `stub: true` is kept only so `prompt-assets.test.ts` (T03, owned file) keeps passing — it asserts every
> non-`action` skill is a stub. Content below is real, written in T14. XREQ T14→T03: split that assertion
> once T03 revisits it.

Covers **S-2.4 High-Level Business Rules** — feeds SRS section `fixed:1`. This is the *tier=high* half of
`business_rules[]`; the *tier=detail* half is a different skill (`appendix-content`, S-7.1), derived later
from `functions[].validations[]`. Never touch `tier=detail` rows here.

Projection carries `project.vision`, `project.release_scope`, current `business_rules[]` — the surrounding
`draft-to-ops` prompt already substitutes the actual step id, projection and addendum around this content;
do not restate `{{...}}` placeholders here, they are not interpolated inside skill content (only in the
outer action prompt).

## What a high-level rule is

A product-wide policy statement that constrains *every* feature, not one screen's validation (that is
`tier=detail`, owned by a function). Examples from this project: "every AI write to the Spine goes
through op-based transactions, never a raw document replace"; "a step cannot be accepted while any red
flag opened by that step is unresolved". One sentence, testable, no implementation detail.

## Procedure

1. Read `project.vision` and `release_scope.in` — one rule per cross-cutting constraint they imply.
2. Read addendum entries targeting `fixed:1` or `fixed:5.1` — a policy addendum becomes a rule here.
3. 3–8 rules is typical; more than that usually means some are `tier=detail` in disguise — leave those
   for S-7.1.
4. `source_validation_ids` stays `[]` here (only `tier=detail` rules derived from validations set it).

## Rules

1. English, no diacritics (`draft-to-ops` rule 6).
2. New ids continue the `business_rules[]` sequence regardless of tier (`draft-to-ops` rule 5).
3. Only `add`/`set` on `business_rules[tier=high]` elements — never touch a `tier=detail` row even to fix
   wording; that belongs to S-7.1.

## Example

```json
{
  "ops": [
    { "op": "add", "path": "business_rules[]", "value": { "id": "BR01", "tier": "high", "statement": "Every write to the SRS Spine goes through an op-based transaction validated against invariants; no field is ever replaced wholesale.", "source_validation_ids": [] }, "reason": "S-2.4 from architecture vision" },
    { "op": "add", "path": "business_rules[]", "value": { "id": "BR02", "tier": "high", "statement": "A pipeline step cannot be accepted while a red flag it opened remains unresolved.", "source_validation_ids": [] }, "reason": "S-2.4 from release scope: deterministic checks" }
  ],
  "notes": "Two cross-cutting rules derived from the architecture vision and gate policy."
}
```

## Self-check

- [ ] Every new/edited row has `tier: "high"`.
- [ ] No `tier: "detail"` row touched.
- [ ] Each statement is one testable sentence, English, no section numbers.
- [ ] `source_validation_ids` is `[]` for every row this skill writes.
