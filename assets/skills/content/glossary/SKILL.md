---
skill_id: glossary
kind: content
version: 0.3.0
description: "S-8.1 sweep the Spine for domain terms and abbreviations into glossary[]"
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 6144
temperature: 0.3
reads:
  - "glossary[]"
  - "actors[]"
  - "entities[]"
  - "screens[]"
  - "features[]"
  - "project"
writes:
  - "glossary[]"
  - "assumptions[]"
output_schema: opTransaction
language: en
stub: false
---
# Glossary

Covers **S-8.1 Glossary** — feeds `fixed:5.5`, a **derived** section: it is rendered from `glossary[]`
every time the document is assembled and never goes stale on its own. The user confirms the list at the
step gate. `references/*.md` are **not loaded at runtime**; rules are inlined.

Shape: `{id, term, term_native?, definition}`.

## What earns an entry

Three kinds, and nothing else:

1. **Domain terms** a newcomer to this product would not know, or would guess wrong: "Spine", "Baseline",
   "Gate", "Credit Reservation", "Addendum". The test is whether two readers could disagree about what it
   means inside this SRS.
2. **Abbreviations and acronyms** that appear anywhere in the Spine: SRS, NFR, ERD, RTO, RPO, MoSCoW,
   WCAG, SLA, OTP. Expand them once here so §3/§4 can use the short form.
3. **Product-specific names of things the reader will meet**: the entities from §3.1.5, the actor names
   from §2.1, and feature names that are not self-explanatory. Prefer the entity's own name verbatim —
   a glossary that renames things is worse than none.

## What does NOT earn an entry

Ordinary English ("user", "project", "report"), unless this product gives it a narrower meaning — in
which case the definition must state that narrower meaning explicitly. Screen names that are literally
what they say ("Login"). Technology names that never appear in the requirements text. Anything you have to
invent a definition for: if the Spine does not say what it means, that is an `assumptions[]` entry or an
open question, not a glossary line.

## Writing a definition

- One sentence, present tense, no leading article, no "refers to" / "is defined as".
- **Define it inside this product**, not in general: "Baseline — a frozen, numbered snapshot of the
  document that later changes are measured against", not "a reference point in project management".
- Do not use the term inside its own definition, and do not chain more than one level of jargon: if the
  definition needs another glossary term, that term must have its own entry.
- `term_native` holds the local-language equivalent **only** when the product's users genuinely say it in
  that language; otherwise omit the field entirely rather than setting `""`.

## Ordering and duplicates

Entries render alphabetically by `term`, so do not try to control order with ids. One entry per concept:
merge "SRS" and "Software Requirements Specification" into a single `term: "SRS"` whose definition
expands the acronym. Check the projection before adding — the glossary is swept again at S-9.1, and a
duplicate term is the flag that catches it.

## Rules

1. Ids continue the existing sequence (`draft-to-ops` rule 5); check the projection first.
2. Terms are taken from the Spine, not imagined — every entry should be findable in `actors[]`,
   `entities[]`, `screens[]`, `features[]`, or the `project` fields.
3. English `term` and `definition` (`draft-to-ops` rules 6–7); `term_native` is the only exception.
4. Do not edit the collections you read from; if a name is wrong, say so in `notes`.
5. 10–30 entries is the usual range. Fewer than 5 on a real product means the sweep was skipped; more
   than 40 usually means ordinary words crept in.
6. Fast mode: write the most reasonable definition plus an `assumptions[]` entry
   (`status: "unconfirmed"`); Coaching mode leaves the unclear term for Elicit (`draft-to-ops` rule 10).

## Example

```json
{
  "ops": [
    { "op": "add", "path": "glossary[]", "value": { "id": "G01", "term": "SRS", "definition": "Software Requirements Specification, the document this product produces." }, "reason": "S-8.1 abbreviation used throughout" },
    { "op": "add", "path": "glossary[]", "value": { "id": "G02", "term": "Baseline", "definition": "Frozen, numbered snapshot of the document that later changes are measured against." }, "reason": "S-8.1 domain term" },
    { "op": "add", "path": "glossary[]", "value": { "id": "G03", "term": "Credit Reservation", "term_native": "Tam giu credit", "definition": "Credits held while an AI action runs, released or charged when it finishes." }, "reason": "S-8.1 entity from section 3.1.5" }
  ],
  "notes": "Skipped Login and Dashboard — screen names that say what they are."
}
```

## Self-check

- [ ] Every acronym used anywhere in the Spine is expanded exactly once.
- [ ] Every entity from §3.1.5 that is not ordinary English has an entry, under its own name.
- [ ] No ordinary English word without a product-specific narrowing.
- [ ] No definition uses its own term, and every jargon word inside a definition has its own entry.
- [ ] No duplicate terms; `term_native` present only where users really use it.
- [ ] Nothing invented — anything the Spine does not define became an assumption or a note instead.
