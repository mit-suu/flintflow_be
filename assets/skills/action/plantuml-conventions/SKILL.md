---
skill_id: plantuml-conventions
kind: action
version: 1.2.0
description: Shared rules for every SRS diagram (kinds, notation, splitting, naming, layout) and the compile-error fix call (render_fix)
provider: anthropic
aiModel: claude-haiku-5-5
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

# Diagram Conventions

Every SRS diagram is drawn by **deterministic renderer code from Spine data**; the model never draws. Two paths:

- **`puml`**: Spine → renderer → `.puml` → compile-check → self-hosted PlantUML server → SVG + PNG.
- **`svg`**: Spine → renderer → SVG (svg-kit, FLF-339) → PNG.

Both store `diagrams[]` + `source_hash`. `render_fix` applies to the `puml` path only. No Excalidraw, no Mermaid, no client-side rendering.

This skill is the shared contract for every renderer (`renderer/*`) and the prompt for the `render_fix` call when compile-check fails.

## Kinds

| SRS section | SRS content (ISO/IEC/IEEE 29148) | `kind` | `owner_kind` | Notation | Path | Ticket |
| --- | --- | --- | --- | --- | --- | --- |
| `fixed:1` | Product perspective / system interfaces | `context` | `null` (one diagram) | DFD level 0 (Yourdon/DeMarco) | svg | FLF-322 |
| `fixed:2.2.1` | Functional requirements — user view | `usecase` | feature | UML 2.5.1 Use Case | svg | FLF-323 |
| `fixed:3.1.1` | User interfaces — navigation | `screen_flow` | feature | UML 2.5 Activity, swimlanes | svg | FLF-340 |
| `fixed:3.1.5` | Logical database requirements | `erd` | `null` (split by cluster) | Chen \| Crow's foot \| IDEF1X (per project) | svg | FLF-324 |
| `feature:<id>` | Logical data model (domain) | `class` | feature | UML 2.5 Class (analysis level) | svg | FLF-325 |
| `function:<id>` | Functional requirements — stimulus/response | `sequence` | function | UML 2.5 System Sequence Diagram (black box) | puml | FLF-326 |
| `fixed:3.1.5` | Modes and states | `state_machine` | entity | UML 2.5 State Machine | svg | FLF-327 |
| `function:<primary_function_id>` | User interfaces — layout | `screen_layout` | screen | Salt wireframe | puml | — |

New kinds, the `svg` path and rules 5, 11 and 12 below are the target: each kind adopts them with the ticket in its row; until then the current renderer and its `renderer/*` skill stay. `SRS section` is the section id the diagram is embedded in (`section-registry.ts`; `feature:<id>` = §3.x, `function:<id>` = §3.x.y). Per-kind syntax and skeletons: `references/kinds.md`.

## Common rules

1. **One notation per kind**, exactly as in the table; never mix notations in one document (ERD notation is chosen per project).
2. **One diagram answers one question.**
3. **Draw only `source_fields`** of the kind (srs-spine §7.1). No element, relation or label that is not in the Spine; anything else makes `source_hash` meaningless.
4. **Aliases are Spine ids** (`A03`, `UC04`, `S7`, `E2`); the visible label is the name: `actor "Reviewer" as A03`. Sort elements by `id` so the same Spine produces the same output.
5. **Split by kind**, not "one diagram per actor":
   - `context`: one diagram for the whole system.
   - `usecase`: one per feature group. Split a group further only where it reads better — by sub-goal (e.g. account access vs organization membership), not by a use-case count; keep each `<<include>>` / `<<extend>>` pair in the same part. No overview diagram. After S-4.1 a use case's feature comes from `function_ids` → `functions[].feature_id` (several ⇒ the first function's in `function_ids` order); the group at S-3.6, before features exist, is set by FLF-323.
   - `screen_flow`, `class`: one per feature.
   - `erd`: whole system; split by connected entity cluster when > ~25 entities.
   - `sequence`: one per function (not every function needs one).
   - `state_machine`: one per entity that has states.
   - Other kinds: more than ~25 nodes ⇒ split further within the same owner. Each part is its own `diagrams[]` entry with the same `kind`.
6. **Actors, swimlanes and lifelines follow the actor–use case model**: use the actor the use case is linked to, keep generalization, never expand to leaf actors, never merge extra actors, use the exact actor name. General actors are defined in §2.1 and its actor hierarchy diagram; other diagrams only use the name and the description below the figure says "see §2.1". Actor unknown ⇒ do not guess.
7. **Naming**: actor, entity and class = singular noun; use case, function and activity action = verb phrase; data-flow label = noun; state = adjective or participle.
8. **Lines and arrowheads follow the notation's semantics, never aesthetics**: solid = association / call / control flow; dashed = dependency / include / extend / reply. Open V, hollow triangle and filled triangle exactly as the standard defines. An arrow without a label where the notation requires one is an error. Create a relation only when the standard's semantics prove it.
9. **Layout**: prefer one straight segment. Orthogonal bends only when a straight line would cross a shape or text, and only for `erd`, `class`, `screen_flow`, `state_machine` (self-transitions, back-edges). No curves, no line over text or shapes, no two overlapping lines, minimal crossings. Cannot meet this ⇒ split the diagram.
10. **Stereotypes in ASCII**: `<<include>>`, never `«include»`.
11. **Visual Paradigm colours**: fill `#7ACFF5`, black border and text, Arial, no shadow; no per-element colours.
12. **Caption + description**: every diagram has a caption `Figure n: <name>` and one description paragraph outside the figure. No notes that restate descriptions.
13. **`puml` technical rules**:
    - Balanced `@start…` / `@end…` (`@startuml`, `@startsalt`, `@startdot`, `@startchen`); exactly one diagram per file.
    - **English labels only.** No Vietnamese diacritics anywhere in the file.
    - No `!include`, no `!import`, no URLs, no sprites or images, no `skinparam` loaded from remote. The server has no internet access.
    - Quote any label containing spaces, punctuation or keywords.

## Self-check before output

- [ ] Notation matches the Kinds table; no mixed notation.
- [ ] Only Spine `source_fields`; aliases are Spine ids, sorted by id.
- [ ] Split matches `owner_kind`; use case parts by sub-goal, other kinds no part over ~25 nodes.
- [ ] Actors / lanes / lifelines are the linked actors, generalization kept, names exact.
- [ ] Names use the right word class (noun / verb phrase / adjective).
- [ ] Line style and arrowheads match the notation; required labels present.
- [ ] No curves, no overlap of lines, text or shapes; bends only where allowed.
- [ ] Visual Paradigm colours; no per-element colours.
- [ ] Stereotypes in ASCII `<<x>>`.
- [ ] Caption `Figure n: <name>` + description paragraph; no restating notes.
- [ ] `puml`: balanced `@start…/@end…`, English labels, no `!include` / URL, labels quoted.

## Compile-error fix (`render_fix`)

Context:

- Kind: {{kind}}
- Current `.puml`:
{{puml}}
- Compiler error from PlantUML server:
{{compile_error}}
- Attempt: {{attempt}} of 2

Fix **only** what the error points at (syntax, unknown keyword, unbalanced brace, missing quote, illegal alias). Do not add, remove or rename elements; the diagram must still represent the same Spine data. Never change notation, line style, arrowheads, colours or layout rules while fixing syntax. After 2 failed attempts code stores the text with `render_status = error` → red flag `render_error`.

Return **only** JSON, no fence:

```json
{ "puml": "@startuml\n...\n@enduml", "notes": "optional: what was fixed" }
```
