---
skill_id: plantuml-conventions
kind: action
version: 1.0.0
description: Shared PlantUML rules for the 5 renderers and the compile-error fix call (render_fix)
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 4096
temperature: 0.1
reads:
  - diagrams[]
  - "<source_fields of the diagram kind: srs-spine §7.1>"
writes:
  - diagrams[]
output_schema: renderFix
language: en
---

# PlantUML Conventions

One diagram path only (Phases §7.1): **model emits `.puml` → `diagrams[]` + `source_hash` → compile-check → self-hosted PlantUML server renders → embedded at export.** No Excalidraw, no Mermaid, no client-side rendering.

This skill is loaded by every renderer (`renderer/*`) as shared rules, and is the prompt for the `render_fix` call when compile-check fails.

## Kinds

| SRS section | `kind` | `owner_kind` | PlantUML | Renderer skill |
| --- | --- | --- | --- | --- |
| §1 Context Diagram | `context` | `null` | component / rectangle | `renderer/context` |
| §2.2.1 Use Case Diagram | `usecase` | `null` | usecase | `renderer/usecase` |
| §3.1.1 Screens Flow | `screen_flow` | `null` (one part per human actor) | Graphviz DOT (`@startdot`) | `renderer/screen-flow` |
| §3.1.5 ERD | `erd` | `null` | entity + crow's foot | `renderer/erd` |
| §3.x.y Screen Layout | `screen_layout` | `screen` | salt | `renderer/screen-layout` |

**No sequence diagrams.** Per-kind syntax and skeletons: `references/kinds.md`.

## Common rules

1. Start with `@startuml` and end with `@enduml` (`@startsalt` for screen layout, `@startdot` for screen flow). Exactly one diagram per file.
2. **English labels only.** No Vietnamese diacritics anywhere in the file.
3. **Draw only `source_fields`** of the kind (srs-spine §7.1). Anything else makes `source_hash` meaningless and forces redraws.
4. **Aliases are Spine ids** (`A03`, `UC04`, `S7`, `E2`); the visible label is the name: `actor "Reviewer" as A03`. Ids stay stable when names change.
5. Sort elements by `id` so the same Spine produces the same text.
6. No `!include`, no `!import`, no URLs, no sprites or images, no `skinparam` loaded from remote. The server has no network access to the internet.
7. Monochrome-friendly: at most `skinparam monochrome true` or a few neutral `skinparam` lines; no custom colours per element.
8. Size: split into several diagrams when > ~25 nodes (use case diagram by actor group, ERD by module). Each part is its own `diagrams[]` entry with the same `kind`.
9. Quote any label containing spaces, punctuation or keywords.
10. No notes that restate descriptions. Screen flow marks pop-ups with a dashed border and a `(pop-up)` line, not a note.

## Compile-error fix (`render_fix`)

Context:

- Kind: {{kind}}
- Current `.puml`:
{{puml}}
- Compiler error from PlantUML server:
{{compile_error}}
- Attempt: {{attempt}} of 2

Fix **only** what the error points at (syntax, unknown keyword, unbalanced brace, missing quote, illegal alias). Do not add, remove or rename elements; the diagram must still represent the same Spine data. After 2 failed attempts code stores the text with `render_status = error` → red flag `render_error`.

Return **only** JSON, no fence:

```json
{ "puml": "@startuml\n...\n@enduml", "notes": "optional: what was fixed" }
```
