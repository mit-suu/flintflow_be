---
skill_id: template-migration-resolve
kind: action
version: 1.0.0
description: FLF-395 (D8) — when a project switches SRS template, either turn the free text of one custom section into structured Spine items, or pick how one conflicting section should be placed in the new template
provider: anthropic
aiModel: claude-haiku-5-5
maxTokens: 2048
temperature: 0
reads:
  - "<one migration item: kind, old section text or conflict description>"
writes: []
output_schema: templateMigrationResolve
language: en
---

# Resolve one template-migration item

A project is moving to a new SRS template. For **one item** the BA asked FlintFlow to decide with AI. You answer for that item only.
Nothing you return is applied blindly: items are validated, dry-run against the project data, and anything invalid is dropped
(the section is then kept as it is, so no content is ever lost).

## Item

- Kind: `{{kind}}`  (`move_structured` = free text of a custom section must become structured items; `conflict` = pick a placement)
- Section: {{heading}}
- Target section / array: {{target}}

### Text of the section (for `move_structured`)

{{text}}

### Allowed array shapes (for `move_structured`)

{{schema}}

### Conflict description and allowed choices (for `conflict`)

{{conflict}}

## Rules for `move_structured`

1. Return `ops` only: `{ "op": "add", "path": "<array>[]", "value": { ... } }` where `<array>` is one of the arrays in "Allowed array
   shapes" and `value` follows that shape exactly. No `id` fields — ids are assigned by the system.
2. One item per distinct requirement / rule / statement the text actually states. Never invent facts, numbers or names.
3. Text that does not fit the allowed shapes (diagrams, long prose with no discrete statements) ⇒ `ops: []` and say why in `notes`.
4. `choice` stays `null`.

## Rules for `conflict`

1. Return `choice` = exactly one of the allowed choices, verbatim. Prefer the choice that loses no column or text.
2. `ops` stays `[]`.
3. Unsure ⇒ the choice that keeps the old table / section unchanged.

## Output

JSON only, no prose outside it.

```json
{ "ops": [{ "op": "add", "path": "other_requirements[]", "value": { "kind": "assumption", "statement": "Nightly batch to the legacy gateway." } }], "choice": null, "notes": null }
```

```json
{ "ops": [], "choice": "map_by_header", "notes": "Old table columns are a subset of the new ones." }
```
