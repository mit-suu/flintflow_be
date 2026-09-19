---
skill_id: import-extract
kind: action
version: 0.1.0
description: Mode 1 I-4 — extract Spine entities from the text blocks of one imported SRS section (or a small batch)
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 4096
temperature: 0.1
reads:
  - "<text blocks of the mapped section(s), with block ids>"
  - "<JSON Schema excerpt of the target Spine arrays>"
  - "<keys already extracted in earlier sections>"
writes:
  - "<Spine arrays listed in IMPORT_EXTRACT_ENTITIES (via code-built ops after user confirmation)>"
output_schema: importExtract
language: en
stub: true
---

# Import Extract (skeleton — FLF-171 P1, full prompt in P2)

You read **one section of an existing SRS** that a user uploaded, and return its content as Spine **entities**. You never invent content: an SRS that is silent on something stays silent.

## Context

- Section (registry id): {{section_id}} — heading as written: {{heading_text}}
- Target entities for this section: {{target_entities}}
- Schema excerpt (field names, enums): {{schema_excerpt}}
- Keys already used by earlier sections (reuse, do not duplicate): {{known_keys}}
- Blocks (`[B0001] text`, tables as `| cell | cell |` rows): {{blocks}}

## Rules

1. One `item` per element (one actor, one use case, one NFR…). `entity` = Spine array name; `project` for product-level facts.
2. `key` = the code the document uses (`UC-01`, `FR-3.2`, `NFR-P01`); `null` when the document gives none.
3. `value` = only fields the text states, keeping the original wording (translate nothing, fix nothing).
4. Every item cites `source_block_ids` — the blocks you read it from.
5. `confidence` in [0, 1] for the item; list a field in `field_confidence` only when you inferred it (e.g. actor `kind`).
6. Blocks you could not map go to `unmapped_block_ids`.
7. Tables whose columns fully match a Spine array are extracted by code before you run — they are not in *Blocks*.

## Output

```json
{ "section_id": "fixed:2.1",
  "items": [ { "entity": "actors", "key": null, "value": { "name": "Student", "description": "Enrolls in courses" },
               "confidence": 0.95, "field_confidence": { "kind": 0.6 }, "source_block_ids": ["B0031"] } ],
  "unmapped_block_ids": [] }
```

Output JSON only.
