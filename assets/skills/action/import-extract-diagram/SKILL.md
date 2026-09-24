---
skill_id: import-extract-diagram
kind: action
version: 1.0.0
description: Mode 1 I-4 (images) — classify one diagram image of an imported SRS section and extract the Spine entities it shows
provider: gemini
aiModel: gemini-3.5-flash
# Model dự phòng khi model chính báo quá tải (503 high demand) — thử lần lượt; 2.5 đã khoá với key mới
fallbackModels:
  - gemini-3.6-flash
  - gemini-3.5-flash-lite
maxTokens: 8192
temperature: 0.1
reads:
  - "<one attached image (PNG/JPEG) from the section, with its block id and caption>"
  - "<field list of the entities a diagram can show>"
  - "<keys already extracted in earlier sections and from the section text>"
writes:
  - "<actors, use_cases, entities, screens (via code-built ops after user confirmation)>"
output_schema: importExtractDiagram
language: user
---

# Read Diagram Image

You look at **one image attached to this message**. It comes from a section of an existing SRS that a user uploaded.
If it is a diagram, you return what it shows as Spine **entities**. The image is the source of truth: you copy the
labels exactly as drawn, you never invent elements, arrows or names that you cannot read.

## Context

- Section (registry id): {{section_id}} — heading as written: {{heading_text}}
- Image block: [{{block_id}}] — caption / text next to it: {{caption}}
- Fields you may fill (names and enums):
{{schema_excerpt}}
- Keys already used — reuse them to refer to the same element, never create a duplicate:
{{known_keys}}

## Step 1 — classify

`diagram_kind`:

- `usecase` — UML use case diagram: stick-figure actors, ovals, system boundary, `<<include>>` / `<<extend>>` arrows.
- `erd` — entity–relationship / class / database diagram: boxes with attributes, relationship lines.
- `screen_flow` — screens (boxes or wireframes) connected by navigation arrows.
- `context` — system context diagram: the system in the middle, external actors / systems around it.
- `other` — anything else (screenshot of one screen, logo, photo, chart, sequence/activity diagram, unreadable
  or blurry image). For `other` return `items: []` — code keeps the original image in the document.

## Step 2 — extract (only for the four diagram kinds)

1. One `item` per element you can read:
   - `usecase`: every actor ⇒ `actors` (`kind`: `human`, or `system` for an external system / service);
     every oval ⇒ `use_cases` with `actor_ids` = the actors linked to it, `includes` / `extends` = the use cases
     at the other end of `<<include>>` / `<<extend>>` arrows (the arrow points **to** the included / extended one
     for include, **from** the extension for extend).
   - `erd`: every box ⇒ `entities` with `relations` = the entities it is connected to.
   - `screen_flow`: every screen ⇒ `screens` with `flow_to` = the screens its outgoing arrows point to.
   - `context`: every external party ⇒ `actors` (`human` or `system`).
2. `key` = the code written in the image (`UC-01`, `SCR-02`) exactly as written, or a key from *Known keys* when the
   element is clearly the same one (same name). `null` when there is none — code assigns one.
3. References (`actor_ids`, `includes`, `extends`, `relations`, `flow_to`) use keys from *Known keys* or, for elements
   without a key, their **name as drawn** — code resolves names.
4. `value` holds only what the image shows (usually just `name` and the references). No descriptions you made up.
5. `source_block_ids`: always `["{{block_id}}"]`.
6. `confidence` in [0, 1]: at most 0.7 — reading an image is never as sure as reading text; 0.5 or less when a
   label is small, cut off or ambiguous. The user confirms every item before it enters the Spine.
7. `unmapped_block_ids`: `[]`.

## Output

JSON only, no prose:

```json
{ "section_id": "fixed:2.2.1",
  "diagram_kind": "usecase",
  "items": [
    { "entity": "actors", "key": null, "value": { "name": "Learner", "kind": "human" },
      "confidence": 0.7, "field_confidence": {}, "source_block_ids": ["B0012"] },
    { "entity": "use_cases", "key": "UC-02", "value": { "name": "Log in", "actor_ids": ["Learner"], "includes": [], "extends": [] },
      "confidence": 0.65, "field_confidence": {}, "source_block_ids": ["B0012"] }
  ],
  "unmapped_block_ids": [] }
```
