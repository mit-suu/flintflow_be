# Per-kind skeletons — source: Phases §7; srs-spine.md §7.1

## `context` — §1 System Context

Source fields: `project.name` · `actors[].name/.kind/.flows_in/.flows_out` · `use_cases[].name/.actor_ids`. Level-0 data flow: system circle in the centre, actors ringed around it, one labelled arrow per direction (`flows_in` into the system, `flows_out` out of it), falling back to the actor's use case names (max 3, then `+ N more`).

```plantuml
@startuml
skinparam monochrome true
skinparam shadowing false
skinparam nodesep 45
skinparam ranksep 110
skinparam usecaseFontSize 16
usecase "\n\n   FlintFlow   \n\n" as SYSTEM_
rectangle "Founder" as A01
rectangle "Payment Gateway" as A05
rectangle "Scheduler" as A09
A01 <-right-> SYSTEM_ : → brief answers, accepted step\n← draft section
A05 <-left-> SYSTEM_ : ← payment result\n→ payment request
A09 -down-> SYSTEM_ : housekeeping tick
@enduml
```

## `usecase` — §2.2.1

Source fields: `actors[].name/.kind` · `use_cases[].name/.actor_ids/.includes/.extends`.

```plantuml
@startuml
skinparam monochrome true
left to right direction
actor "Business Analyst" as A01
actor "Payment Gateway" as A05 <<system>>
rectangle "FlintFlow" {
  usecase "Create Project" as UC01
  usecase "Export SRS" as UC07
  usecase "Pay Subscription" as UC09
}
A01 --> UC01
A01 --> UC07
UC09 --> A05
UC07 .> UC01 : <<include>>
@enduml
```

- `includes[]` → `base .> included : <<include>>`
- `extends[]` → `extension .> base : <<extend>>`
- `kind = time` actors: `actor "Scheduler" as A08 <<time>>`

## `screen_flow` — §3.1.1

Source fields: `screens[].name/.flow_to/.is_popup/.tabs` + the human actor each screen serves.

**Graphviz DOT, not a state diagram**: the flow starts at a diamond with the actor name inside, and a
PlantUML state diagram cannot label a diamond. One part per human actor that uses the UI (graph label
`Screens flow for <actor>`, also the image caption), holding only that actor's screens and the edges between
them; screens no human actor uses go to a last `Unassigned screens` part (black-dot start) and raise
`orphan_screen`. Before any screen ↔ actor link exists: one unlabelled diagram, black-dot start. Arrows are
one-way: of a pair pointing at each other only the forward edge (away from the entry) is drawn.

```
@startdot
digraph screens_flow {
  graph [fontname="DejaVu Sans", fontsize=13, labelloc=t, compound=true, nodesep=0.4, ranksep=0.5];
  node [fontname="DejaVu Sans", fontsize=11, shape=box, style=rounded, color="#000000"];
  edge [arrowsize=0.8];
  label="Screens flow for Founder";
  START [label="Founder", shape=diamond, style=solid];
  S1 [label="Login"];
  S2 [label="Project Dashboard"];
  subgraph cluster_S3 {
    label="Project Workspace"; style=rounded;
    S3_T1 [label="Chat"];
    S3_T2 [label="Document"];
  }
  S4 [label="Confirm Delete\n(pop-up)", style="rounded,dashed"];
  START -> S1;
  S1 -> S2;
  S2 -> S3_T1 [lhead=cluster_S3];
  S2 -> S4;
}
@enddot
```

- Screens with `tabs[]` → `subgraph cluster_<screen>`, one node per tab (`<screen>_T<n>`); edges attach to
  `_T1` with `lhead` / `ltail`.
- `is_popup = true` → dashed border + `(pop-up)` line. Boxes are not filled (PlantUML drops the border of a
  `rounded,filled` node). Font `DejaVu Sans` is required — the default dot font is missing in the image.

## `erd` — §3.1.5

Source fields: `entities[].name/.relations`. Attributes are **not** drawn (not in source fields).

```plantuml
@startuml
skinparam monochrome true
hide circle
hide empty members
entity "User" as E1
entity "Project" as E2
entity "ChatSession" as E3
E1 ||--o{ E2 : owns
E2 ||--|{ E3 : has
@enduml
```

Crow's foot: `||` exactly one · `|o` zero or one · `}|` one or many · `}o` zero or many.

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
