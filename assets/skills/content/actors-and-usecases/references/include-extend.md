# Use case relationships — S-3.4

## `includes` vs `extends`

- `includes[]` — the base use case **always** triggers the included one as part of reaching its goal.
  UML `<<include>>`. Example: "Run Guided Pipeline Step" includes "View Readiness Flags" — every step run
  ends by showing flags, unconditionally.
- `extends[]` — the use case is an **optional** variant/continuation of a base use case, triggered under a
  condition. UML `<<extend>>`. Example: "Accept Step At Gate" extends "Run Guided Pipeline Step" — only
  happens if the user chooses to accept rather than request a revision.

If unsure which direction: ask "does the base use case make sense without this happening?" — if no, it is
`includes`; if yes (it's a conditional branch), it is `extends`.

## Where the field lives

`includes`/`extends` are set **on the use case that has the relationship**, as arrays of use case ids:

- On the base use case: `use_cases[id=UC02].includes` = `["UC06"]` (UC02 includes UC06).
- On the extending use case: `use_cases[id=UC03].extends` = `["UC02"]` (UC03 extends UC02).

Do not set the inverse on the other side — the relationship is directional and stored once.

## Ops shape

Both are `set` on an existing use case's array field — never `add`/`remove` a use case here (S-3.4 wires
relationships, it does not create or delete use cases):

```json
[
  { "op": "set", "path": "use_cases[id=UC02].includes", "value": ["UC06"], "reason": "every pipeline step run shows readiness flags" },
  { "op": "set", "path": "use_cases[id=UC03].extends", "value": ["UC02"], "reason": "accepting is an optional outcome of running a step" }
]
```

## Constraints

- Every id referenced must exist in `use_cases[]` after this batch (own adds from an earlier step count —
  S-3.4 runs after S-3.2/S-3.3 have committed). A dangling id is `dead_reference` (red flag), rejected at
  validation, not just flagged.
- A use case should not `include`/`extend` itself, and a chain should not cycle back (A extends B extends
  A) — if the sweep produces that, the relationship model is wrong; merge or re-scope the use cases
  instead of forcing a cycle through.
- Not every use case needs a relationship — most are standalone. Only wire what the actor-goal analysis
  actually supports; do not invent relationships to look thorough.
