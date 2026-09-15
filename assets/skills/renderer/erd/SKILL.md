---
skill_id: erd
kind: renderer
version: 1.0.0
description: "S-4.5 Entity Relationship Diagram (entity + crow's foot)"
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 4096
temperature: 0.1
reads:
  - "entities[].name"
  - "entities[].relations"
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

- `hide circle`, `hide empty members`.
- `entity "<name>" as <id>` per entity. Attributes are **not** drawn, because they are not `source_fields`.
- `<id> ||--o{ <target>` for every `relations[]` entry that points to an existing entity.
  - `relations[]` stores only target ids, with no cardinality, so every relation uses the default "one to zero-or-many".
  - Real cardinality needs a Spine field; this gap is logged in `docs/spec-gaps.md`.
- A Spine without entities yields a single placeholder entity.
