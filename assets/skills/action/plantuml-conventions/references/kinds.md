# Per-kind skeletons — source: Phases §7; srs-spine.md §7.1

## `context` — §1 System Context

Source fields: `project.name` · `actors[kind≠human].name`. Human actor groups may appear as one `actor` for readability only if already present in `actors[]`.

```plantuml
@startuml
skinparam monochrome true
left to right direction
rectangle "FlintFlow" as SYS
rectangle "Payment Gateway" as A05
rectangle "Email Service" as A06
SYS --> A05 : payment request
A06 <-- SYS : notification
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

Source fields: `screens[].name/.flow_to/.is_popup/.tabs`.

```plantuml
@startuml
skinparam monochrome true
hide empty description
[*] --> S1
state "Login" as S1
state "Project Dashboard" as S2
state "Project Workspace" as S3 {
  state "Chat" as S3_T1
  state "Document" as S3_T2
}
state "Confirm Delete" as S4
note right of S4 : pop-up
S1 --> S2
S2 --> S3
S2 --> S4
@enduml
```

- Screens with `tabs[]` → composite state, one sub-state per tab (`<screen>_T<n>`).
- `is_popup = true` → attach `note … : pop-up`.

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
