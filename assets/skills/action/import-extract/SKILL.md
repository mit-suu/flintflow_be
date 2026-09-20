---
skill_id: import-extract
kind: action
version: 1.0.0
description: Mode 1 I-4 — extract Spine entities from the text blocks of one imported SRS section
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 4096
temperature: 0.1
reads:
  - "<text blocks of one mapped section, with block ids>"
  - "<field list of the target Spine arrays>"
  - "<keys already extracted in earlier sections>"
writes:
  - "<Spine arrays listed in IMPORT_EXTRACT_ENTITIES (via code-built ops after user confirmation)>"
output_schema: importExtract
language: user
---

# Import Extract

You read **one section of an existing SRS** that a user uploaded and return its content as Spine **entities**.
The document is the source of truth: you copy what it says, you never invent, complete, translate or improve it.
An SRS that is silent on something stays silent — leave the field out.

## Context

- Section (registry id): {{section_id}} — heading as written: {{heading_text}}
- Target entities for this section: {{target_entities}}
- Fields you may fill (names and enums):
{{schema_excerpt}}
- Keys already used by earlier sections — reuse them to refer to the same element, never create a duplicate:
{{known_keys}}
- Blocks of the section (`[B0001] text`; a table is `[B0020] (table)` followed by `| cell | cell |` rows):
{{blocks}}

## Rules

1. One `item` per element (one actor, one use case, one NFR, one message…). `entity` is the Spine array name from
   *Target entities*; use `project` only for product-level facts (vision, goals, type, domain).
2. `key` = the code the document gives the element (`UC-01`, `BR-12`, `NFR-P01`, `MSG001`), exactly as written.
   `null` when the document gives no code — code assigns one. For a function section, the function is the section
   itself: return exactly one `functions` item for it with `key: null`.
3. `value` holds only fields the text states, in the document's own wording and language. Lists (`goals`,
   `normal`, `abnormal`, `tabs`) are arrays of strings, one step or item per string, without numbering.
4. References use keys from *Known keys* (`actor_ids: ["A01"]`). If the text names something that has no key yet,
   write its name instead (`actor_ids: ["Learner"]`) — code resolves names; unknown names are dropped, not guessed.
5. Every item cites `source_block_ids`: the blocks you read it from, taken only from the block list above.
6. `confidence` in [0, 1] for the item: 0.9+ when the text states it plainly, 0.6–0.8 when you had to interpret
   the structure (e.g. which sentence is the trigger). List a field in `field_confidence` only when you inferred it
   rather than read it (e.g. actor `kind`, NFR `kind`, rule `tier`) — typically 0.5–0.7.
7. Blocks that carry no requirement content (intro sentences, notes, "N/A", captions) go to `unmapped_block_ids`.
8. Tables whose columns fully matched a Spine array were extracted by code before you ran — they are not in the
   block list, and you must not re-create those elements.

## Output

JSON only, no prose:

```json
{ "section_id": "fixed:2.1",
  "items": [
    { "entity": "actors", "key": null,
      "value": { "name": "Student", "kind": "human", "description": "Enrolls in courses and takes quizzes" },
      "confidence": 0.95, "field_confidence": { "kind": 0.6 }, "source_block_ids": ["B0031"] }
  ],
  "unmapped_block_ids": ["B0030"] }
```
