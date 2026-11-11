# Activity flow of a use case (FLF-390) — only on request

The Activity Diagram of a use case is **not** part of the FlintFlow (FPT) template: write `activity_nodes` /
`activity_flows` **only when the user asks for it** (chat or change request: "add an activity diagram for Log in"), or when
the request is about the "Functions" part of an IEEE template that needs it. A normal S-3.x step writes none.

**`use_cases[id=…].activity_nodes[]` + `.activity_flows[]`** — the processing flow of the use case; one `set` of each whole
array per use case. Build them from the use case description and the `normal[]` / `abnormal[]` steps of its functions —
no extra behaviour.

- Node `{id, kind, name?, lane?}`: `id` = `<use case id>-AN<n>` in order (`UC02-AN1`…); `kind` one of `initial`, `action`,
  `decision`, `merge`, `fork`, `join`, `final`. Exactly one `initial`; at least one `final`.
- `action.name`: a short verb phrase of one step ("Validate credentials", "Show error message"); `decision.name`: the
  question ("Credentials valid?"); other kinds have no name.
- `lane`: who does the step — an actor id of the use case (`actor_ids`, general actor as modelled) or `system`. Give
  every `action` a lane when two or more parties take part; the other kinds may leave it out (they inherit it).
- Flow `{from, to, guard?}`: node ids of the same use case. Every flow out of a `decision` has a `guard` (the condition,
  no brackets: "credentials do not match"); a decision has ≥ 2 outgoing flows. A retry is a flow back to the earlier
  action. Never a flow into `initial`, out of `final`, or from a node to itself. `fork` ≥ 2 out, `join` ≥ 2 in.

## Example

```json
{ "op": "set", "path": "use_cases[id=UC02].activity_nodes", "value": [
  { "id": "UC02-AN1", "kind": "initial" },
  { "id": "UC02-AN2", "kind": "action", "name": "Enter email and password", "lane": "A01" },
  { "id": "UC02-AN3", "kind": "action", "name": "Validate credentials", "lane": "system" },
  { "id": "UC02-AN4", "kind": "decision", "name": "Credentials valid?" },
  { "id": "UC02-AN5", "kind": "action", "name": "Show error message", "lane": "system" },
  { "id": "UC02-AN6", "kind": "action", "name": "Open home page", "lane": "system" },
  { "id": "UC02-AN7", "kind": "final" } ], "reason": "Activity diagram requested by the user" }
{ "op": "set", "path": "use_cases[id=UC02].activity_flows", "value": [
  { "from": "UC02-AN1", "to": "UC02-AN2" }, { "from": "UC02-AN2", "to": "UC02-AN3" }, { "from": "UC02-AN3", "to": "UC02-AN4" },
  { "from": "UC02-AN4", "to": "UC02-AN5", "guard": "credentials do not match" }, { "from": "UC02-AN4", "to": "UC02-AN6", "guard": "credentials match" },
  { "from": "UC02-AN5", "to": "UC02-AN2" }, { "from": "UC02-AN6", "to": "UC02-AN7" } ], "reason": "Activity diagram requested by the user" }
```

## Self-check

- [ ] Written only because the user asked (or the IEEE Functions part needs it); one `initial`, actions are verb phrases with a lane, every decision branch guarded, every node reachable from `initial`.
