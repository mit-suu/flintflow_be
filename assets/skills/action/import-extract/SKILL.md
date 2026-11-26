---
skill_id: import-extract
kind: action
version: 1.0.0
description: Mode 1 I-4 - extract Spine entities from the text blocks of one imported SRS section
provider: anthropic
aiModel: claude-haiku-5-5
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
An SRS that is silent on something stays silent - leave the field out.

## Context

- Section (registry id): {{section_id}} - heading as written: {{heading_text}}
- Target entities for this section: {{target_entities}}
- Other entities you may return when a block clearly holds that kind of element: {{other_entities}}
- Fields you may fill (names and enums):
{{schema_excerpt}}
- Keys already used that these blocks may refer to (a relevant subset, not every element) - reuse them to refer to the
  same element, never create a duplicate:
{{known_keys}}
- Blocks of the section (`[B0001] text`; a table is `[B0020] (table)` followed by `| cell | cell |` rows):
{{blocks}}
- Guidance check - block ids below read like leftover template instructions (placeholder text for whoever fills this
  template in), but the signal alone is not enough to be sure; decide for each one (rule 10). `none` = skip this part:
  {{guidance_candidates}}

## Rules

0. Read by **content, not by the heading's name**. The heading may be a free title ("What the system can do",
   "Part 3") or name the wrong thing. Decide the kind of each element from what the text says.
1. One `item` per element (one actor, one use case, one NFR, one message…). `entity` is the Spine array name from
   *Target entities*, or from *Other entities* when the text is clearly that kind (a requirements list mixing
   functions and NFRs: each element goes to its own array). Use `project` only for product-level facts.
2. `key` = the code the document gives the element (`UC-01`, `BR-12`, `NFR-P01`, `MSG001`), exactly as written.
   `null` when the document gives no code - code assigns one. Prose without tables or codes is fine: one item per
   requirement sentence, `key: null`. For a function section, the function is the section itself: return exactly
   one `functions` item for it with `key: null`.
3. `value` holds only fields the text states, in the document's own wording and language. Lists (`goals`,
   `normal`, `abnormal`, `tabs`) are arrays of strings, one step or item per string, without numbering.
4. References use keys from *Known keys* (`actor_ids: ["A01"]`). If the text names something that has no key yet,
   write its name instead (`actor_ids: ["Learner"]`) - code resolves names; unknown names are dropped, not guessed.
5. Every item cites `source_block_ids`: the blocks you read it from, taken only from the block list above.
6. `confidence` in [0, 1] for the item: 0.9+ when the text states it plainly, 0.6–0.8 when you had to interpret
   the structure (e.g. which sentence is the trigger). List a field in `field_confidence` only when you inferred it
   rather than read it (e.g. actor `kind`, NFR `kind`, rule `tier`) - typically 0.5–0.7.
7. Blocks that carry no requirement content (intro sentences, notes, "N/A", captions) go to `unmapped_block_ids`.
8. Tables whose columns fully matched a Spine array were extracted by code before you ran - they are not in the
   block list, and you must not re-create those elements.
9. Trust content over the heading. When the blocks are not what the heading says (a "Use Case" section that holds
   test cases), set `content_mismatch: { "content": "<what the blocks really are, a few words>" }`; do not force
   them into the heading's entity. Otherwise `content_mismatch` is `null`.
10. For every block id listed under *Guidance check*, decide whether it is really leftover instruction/placeholder
    text for the next author, not a real requirement the document's author wrote. Return each one in
    `guidance_blocks` with `is_guidance` (true/false) and your own `confidence` (0-1, keep it low when the wording
    could honestly go either way). Never add an id that is not listed there. Still extract any real content you
    find in those blocks as usual (rule 1) regardless of your guess - a human confirms the final answer. Nothing
    listed - return `guidance_blocks: []`. An entry written `B0040 (table cell: "...")` is one cell of a table above;
    its id is `B0040` (never the table's id).
11. Classify every block of the section by the kind of content under ISO/IEC/IEEE 29148 (`iso29148`: a short label such as
    `functional requirement`, `constraint`, `interface`, `cost estimate`, `project schedule`, `staffing`). Return one
    `content_types` entry per block with `in_scope` (true when an SRS under 29148 holds that kind of content, false for
    content outside an SRS such as cost estimates, budgets, schedules or staffing plans) and your own `confidence`
    (0-1). Judge by what the text says, not by the heading. Classification only: never drop or skip an element because
    it is out of scope, and keep extracting items as usual (rule 1).

## Output

JSON only, no prose:

```json
{ "section_id": "fixed:2.1",
  "items": [
    { "entity": "actors", "key": null,
      "value": { "name": "Student", "kind": "human", "description": "Enrolls in courses and takes quizzes" },
      "confidence": 0.95, "field_confidence": { "kind": 0.6 }, "source_block_ids": ["B0031"] }
  ],
  "unmapped_block_ids": ["B0030"],
  "content_mismatch": null,
  "guidance_blocks": [{ "block_id": "B0032", "is_guidance": true, "confidence": 0.55 }],
  "content_types": [{ "block_id": "B0031", "iso29148": "functional requirement", "in_scope": true, "confidence": 0.9 }] }
```
