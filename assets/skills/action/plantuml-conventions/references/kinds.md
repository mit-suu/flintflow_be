# Per-kind skeletons — source: Phases §7; srs-spine.md §7.1

## `context` — §1 System Context

Source fields: `project.system_name ?? project.name` · `actors[].name/.kind/.flows_in/.flows_out`. Engine `svg` (no PlantUML source): level-0 data flow in Yourdon/DeMarco notation — ONE circle for the whole system, one rectangle per external actor (fill `#7ACFF5`, role name inside), people on the left half and external systems / scheduler on the right half. Every `flows_in` item (actor → system) and every `flows_out` item (system → actor) is its own straight arrow with a solid head and one Title Case data-noun label along it on white; no limit, no merging, no unlabelled arrows, no data stores, no flows between entities, no title. One-way actors draw only the arrows that exist — never pair lists by index or invent a counterpart — but the diagram as a whole always has both directions; missing flows get a fallback label by kind. See `renderer/context` for the full rules.

## `usecase` — §2.2.1 (+ actor hierarchy §2.1)

Source fields: `actors[].name/.kind/.parent_id` · `use_cases[].name/.actor_ids/.function_ids/.includes/.extends` · `functions[].feature_id` · `features[].name/.order`.

Engine `svg` (no PlantUML source): UML 2.5.1 built in code, fill `#7ACFF5`.

- One system boundary named `project.system_name ?? project.name`; every use case an ellipse of the same size in one column.
- Actor = stick figure, human on the left, `system`/`time` on the right (`<<system>>` / `<<time>>`), outside the boundary; abstract actors (with children) in italic.
- Association = solid straight line, no arrowhead. `includes[]` → `base ..> included : <<include>>`; `extends[]` → `extension ..> base : <<extend>>` — dashed, open arrowhead, vertical between adjacent ellipses.
- One diagram per feature (`function_ids` → `functions[].feature_id`, several ⇒ the first function's feature); no feature ⇒ grouped by main actor after the features. Over 20 use cases ⇒ split equally in the same feature; `owner_kind` / `owner_id` stay `null`, the first part keeps the original id.
- Actors as modelled: general actors stay general, never expanded to leaf actors. A human actor skips the edge to a use case that is included / extending in the same diagram; `system`/`time` actors keep every edge.
- `actors[].parent_id` (human → human) ⇒ one extra diagram (`section = fixed:2.1`): actor hierarchy, child below parent, solid line, hollow triangle at the parent. Use cases have no parent field ⇒ no use case generalization.
- Layout rules and algorithm: `renderer/usecase/SKILL.md`, `docs/technical/usecase-diagram-layout.md`.

## `screen_flow` — §3.1.1

Source fields: `screens[].name/.flow_to[].to/.trigger/.guard/.is_popup/.tabs/.feature_id` · `features[].name/.order` · `actors[].name/.parent_id` + the actor of each screen (screen → `primary_function_id` → function → use case → `actor_ids`).

Engine `svg` (no PlantUML source): UML 2.5 Activity Diagram with swimlanes built in code, fill `#7ACFF5`.

- One diagram per feature; over 25 screens ⇒ split equally (`<feature> (1/2)`). `owner_kind` / `owner_id` stay `null`, the first part keeps the original id. Screens whose feature does not exist go to a last group.
- Swimlane = the actor performing the screen, exact actor name in the lane header; general actor kept (several actors with a common ancestor ⇒ the ancestor's lane), never expanded to leaf actors. Ambiguous actors (no common ancestor) ⇒ first actor + yellow flag `screen_actor_ambiguous`. No actor ⇒ screen not drawn (`orphan_screen`). No link at all yet ⇒ no lane frames.
- Screen = action (rounded rectangle); pop-up = action with stereotype `<<pop-up>>`; tabs = line `[tab | tab]` under the name. Initial node (solid dot) above each entry screen, activity final (ring + dot) below each ending screen.
- Control flow = solid line, open arrowhead, one per `flow_to` edge inside the diagram (forward only: of a pair pointing at each other only the edge away from the entry; return navigation implicit). Straight, or orthogonal bends when a straight line would cross a shape.
- `trigger` = horizontal label on the arrow; edges of one screen with the same trigger, ≥ 2 and some `guard` ⇒ decision node (filled `#7ACFF5` diamond), trigger on screen → diamond, `[guard]` / `[else]` on each branch. Full rules: `renderer/screen-flow/SKILL.md`.

## `erd` — §3.1.5

Source fields: `entities[].name/.relations/.relation_verbs/.relation_cardinality/.relation_optional`. Attributes are **not** drawn (not in source fields).
Chen notation: entity = rectangle, each relation = a diamond holding a lowercase verb (`relation_verbs`, `has`
when missing). Braces after `entity` / `relationship` are required even when empty.

```plantuml
@startchen
skinparam monochrome true
skinparam ranksep 20
skinparam linetype ortho
entity "User" as E1 {
}
entity "Project" as E2 {
}
relationship "owns" as R_E1_E2 {
}
E1 -1- R_E1_E2
R_E1_E2 -N- E2
@endchen
```

Cardinality labels on the lines: `-1-` one · `-N-` many · `-(0,1)-` optional one. The parent side is `1`, or `(0,1)` when the child is in `relation_optional` (never `-0..1-`: a syntax error in `@startchen`); the child side is `relation_cardinality[<child>]`, `N` when missing.

## `screen_layout` — §3.x.y (core screens only, Phases §7.2)

Source fields: `screens[<owner>].name` · `functions[screen_id=<owner>].name/.description`. Attached to `screens[].primary_function_id`.

```plantuml
@startsalt
{+
  <b>Invoice List
  { "Search invoice" | [Search] | [New Invoice] }
  {#
    Code | Customer | Amount | Status
    INV-001 | ACME | 1,200 | Paid
  }
  { [Export] | [Delete] }
}
@endsalt
```

- Low-fi on purpose: what the screen has and does, not how it looks.
- Repeated CRUD admin screens: one template salt + a variant table, not one salt each.
- `@startsalt … @endsalt` replaces `@startuml … @enduml` for this kind only.
