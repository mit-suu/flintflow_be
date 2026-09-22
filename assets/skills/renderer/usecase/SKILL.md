---
skill_id: usecase
kind: renderer
version: 1.1.0
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
stub: false
---
# Usecase

> The renderer is deterministic code: `src/modules/diagram/renderers/usecase.renderer.ts`. This skill documents the output and is loaded with `action/plantuml-conventions` only by the `render_fix` call.

- Step: S-3.6 Use Case Diagram · Section: `fixed:2.2.1` · Output: `puml`

## Output

- `actor "<name>" as <id>`; `kind = system` adds `<<system>>` and `kind = time` adds `<<time>>`.
- All use cases sit inside `rectangle "<project.name>" { usecase "<name>" as <id> }`.
- Association (no arrowhead) for every `actor_ids[]` entry. The edge direction sets the side under `left to right direction`: a `human` actor is written `actor -- use case` (left), a `system`/`time` actor `use case -- actor` (right). Human actors are declared before the `rectangle`, system/time actors after it.
- A **human** actor is not connected to a use case that has `extends[]` or is included by another use case: it reaches it through the base use case. A human actor whose every edge would be dropped keeps the edge to its smallest use case id, so it never disappears. `system`/`time` actors keep every edge (they take part in exactly that extension, e.g. the payment gateway in "Pay Deposit").
- Only actors that still have an edge in that part are declared.
- `base ..> included : <<include>>` for `includes[]`.
- `extension ..> base : <<extend>>` for `extends[]` (the use case holding `extends[]` is the extension).

## Order and splitting

- Use cases are emitted by group, then relation cluster, then id. The group key of a cluster is its first **human** actor (use cases by id, `actor_ids[]` in order); a cluster with no human actor falls back to its smallest actor id, `~` → `Other`. Groups are ordered by key.
- A relation cluster is a connected component of the undirected include/extend graph, so an extension or an included use case stays with its base.
- One diagram holds at most 20 use cases **and** at most 24 actor–use case edges. Within the limits there is a single part without a title. Over either limit, whole groups are packed into parts (each human actor stays in one part when its group fits); a group that alone exceeds a limit is packed cluster by cluster.
- A cluster longer than 40 (hard ceiling) is chunked into lots of 20; only there can an include/extend edge cross a part boundary, and such an edge is dropped.
- Each part is its own `diagrams[]` entry with the same `kind`. The first part keeps the unsuffixed id (`<base>`, then `<base>-2`, `<base>-3`, …) so a signed baseline referencing `<base>` keeps its image.
- Title is `Use Cases — <group actor names in that part, joined by " / ">`; a single part has no title.
