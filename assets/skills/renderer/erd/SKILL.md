---
skill_id: erd
kind: renderer
version: 1.1.0
description: "S-4.5 Entity Relationship Diagram (Chen notation: entity + verb diamond)"
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 4096
temperature: 0.1
reads:
  - "entities[].name"
  - "entities[].relations"
  - "entities[].relation_verbs"
  - "entities[].relation_cardinality"
  - "entities[].relation_optional"
writes:
  - "diagrams[kind=erd]"
output_schema: puml
language: en
stub: false
---
# Erd

> The renderer is deterministic code: `src/modules/diagram/renderers/erd.renderer.ts`. This skill documents the output and is loaded with `action/plantuml-conventions` only by the `render_fix` call.

- Step: S-4.5 Entity Relationship Diagram · Section: `fixed:3.1.5` · Output: `puml`

## Output

- Chen notation: `@startchen` … `@endchen`, `skinparam monochrome true`, `skinparam ranksep 20` (each diamond adds a rank, so the default spacing makes deep parent–child chains very tall), `skinparam linetype ortho` (right-angle lines instead of crossing curves).
- `entity "<name>" as <id> {` + `}` per entity. The braces are required, even when empty. Attributes are **not** drawn, because they are not `source_fields`.
- For every `relations[]` entry that points to an existing entity, one diamond holding the verb:
  - `relationship "<verb>" as R_<parent>_<child> {` + `}`
  - `<parent> -<p>- R_<parent>_<child>` and `R_<parent>_<child> -<c>- <child>`, where `<p>` is `(0,1)`
    when the child is in the parent's `relation_optional` and `1` otherwise, and `<c>` is
    `relation_cardinality[<child id>]` (`1` for one-to-one), `N` when missing. Never `-0..1-`: it is a
    syntax error in `@startchen`; the min–max form `(0,1)` is the valid one.
  - `<verb>` is `relation_verbs[<child id>]`, or `has` when it is missing, so a diamond is never empty.
- A Spine without entities yields a single placeholder entity.

## Example

```
@startchen
skinparam monochrome true
skinparam ranksep 20
skinparam linetype ortho
entity "Project" as E01 {
}
entity "Document Version" as E02 {
}
relationship "contains" as R_E01_E02 {
}
E01 -1- R_E01_E02
R_E01_E02 -N- E02
@endchen
```
