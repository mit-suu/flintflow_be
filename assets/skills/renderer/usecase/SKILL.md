---
skill_id: usecase
kind: renderer
version: 1.0.0
description: "S-3.6 Use Case Diagram (usecase, include/extend)"
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 4096
temperature: 0.1
reads:
  - "actors[].name"
  - "actors[].kind"
  - "use_cases[].name"
  - "use_cases[].actor_ids"
  - "use_cases[].includes"
  - "use_cases[].extends"
writes:
  - "diagrams[kind=usecase]"
output_schema: puml
language: en
stub: true
---
# Usecase

> The renderer is deterministic code: `src/modules/diagram/renderers/usecase.renderer.ts`. This skill documents the output and is loaded with `action/plantuml-conventions` only by the `render_fix` call. `stub: true` stays until the T03 asset test stops requiring it (XREQ T10→T03).

- Step: S-3.6 Use Case Diagram · Section: `fixed:2.2.1` · Output: `puml`

## Output

- `actor "<name>" as <id>`; `kind = system` adds `<<system>>` and `kind = time` adds `<<time>>`.
- All use cases sit inside `rectangle "<project.name>" { usecase "<name>" as <id> }`.
- `actor --> use case` for every `actor_ids[]` entry.
- `base ..> included : <<include>>` for `includes[]`.
- `extension ..> base : <<extend>>` for `extends[]` (the use case holding `extends[]` is the extension).

## Splitting (> 25 use cases)

- Use cases are grouped by primary actor (smallest `actor_ids[]` id). Groups are packed into parts of at most 25; a group larger than 25 is chunked.
- Each part is its own `diagrams[]` entry with the same `kind`, ids `<base>-1`, `<base>-2`, …, and title `Use Cases (part i of n)`.
- Include/extend edges are drawn only when both ends are in the same part.
- The previous single diagram id is removed when a split appears, and vice versa.
