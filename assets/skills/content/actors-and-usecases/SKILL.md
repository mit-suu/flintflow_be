---
skill_id: actors-and-usecases
kind: content
version: 0.6.0
description: "S-3.1–S-3.5 actors, roles, actor–goal list, missing use case sweep, relationships, descriptions"
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 6144
temperature: 0.3
reads:
  - "actors[]"
  - "roles[]"
  - "use_cases[]"
  - "functions[].id"
  - "addendum[]"
writes:
  - "actors[]"
  - "roles[]"
  - "use_cases[]"
  - "assumptions[]"
output_schema: opTransaction
language: en
stub: false
---
# Actors And Usecases

Covers **S-3.1 Actors, S-3.2 Actor–Goal List, S-3.3 Missing Use Case Sweep, S-3.4 Use Case Relationships,
S-3.5 Use Case Descriptions** — feeds `fixed:2.1` (Actors) and `fixed:2.2.2` (Use Case Descriptions).
`fixed:2.2.1` (the diagram) is `S-3.6`, render-only, no skill. You produce **data**, never a drawing: code
renders the diagram from `actors[]`, `use_cases[]`, `actor_ids`, `includes`, `extends` — no PlantUML/arrows.

## S-3.1 — Actors

Add every human, system and time actor implied by the Brief/addendum and any `actors[kind=system]` already added
at S-2.3 (do not duplicate). Kinds: `human` (operates via UI, gets a role unless sharing one), `system` (external
integration, no role), `time` (scheduler/cron/trigger, no UI, no role). An actor is a type of party, not a
job-title synonym. **Derive, do not wait to be told**: an external capability the product calls out to ⇒ a
`system` actor; anything that expires, resets or runs on a schedule ⇒ a `time` actor. One `roles[]` row per (human
actor, distinct permission set); `actor_id` must be a `human` actor's id, never `null` at creation; add the actor
before its role in the same batch. **Access**: for every human actor decide how it gets in — `self-registers`,
`invited` (account created by another actor), `identity provider` (sign-in delegated; the provider is a `system`
actor) or `no sign-in` — and say it in its `description`. Brief/addendum silent ⇒ pick the likeliest and write
**one** `assumptions[]` entry (`path: "actors[]"`) for all unresolved actors — one combined question for the gate.

Naming: **A1** a singular role/party noun phrase, never a person's name or a team. **A3** never named after a
screen or a feature ("Dashboard User" ⇒ "Project Owner"). **A4** a `system` actor is the outside role, not the
vendor or version ("Stripe API v3" ⇒ "Payment Gateway"). **A5** a `time` actor is named after what it triggers
("Cron" ⇒ "Nightly Billing Scheduler"). **A6** two names sharing every capability are one actor with two `roles[]`
rows. **A8** `description` is one sentence tied to this product, saying who they are, what they do here and why
they care — not a dictionary gloss.

## S-3.2 — Actor–Goal List

For each actor, list what it needs to accomplish; each goal becomes one `use_cases[]` candidate: `{id, name,
actor_ids, function_ids: [], description: "<actor, trigger, outcome — one full sentence, written now, not deferred
to S-3.5>", includes: [], extends: []}`.

`actor_ids` = every actor that **participates** in the use case (UML association), primary actor first.
Participation is not initiation: an actor the flow calls out to belongs here too. Do not invent a use case for a
`system` or `time` actor just to give it something to do — it participates in the use case it is actually part of.
A **notification actor** (email, SMS, push) sits on the use case whose flow *changes a state and emits the event*
("Assign Order to Driver" sends the SMS), never on one that only reads a state ("Track Order"); a `time` actor
sits on the use case it starts. **Account use cases follow S-3.1 access**, for exactly the actors concerned:
`self-registers` ⇒ Register Account; `self-registers`/`invited` ⇒ Log In + Reset Password; `invited` ⇒ "Create
<Actor> Account" for the managing actor; `identity provider` ⇒ Log In with the provider as participant, no
Register/Reset; `no sign-in` ⇒ none.

One use case = one goal reachable in one sitting, independent of UI screens: "Manage Project" is too coarse (split
by real goal), "Click Accept Button" is too fine. Naming: **U7** the object uses the business term from the
Brief/Glossary, the same term throughout. **U9** the name shows the value the actor gets ("Update Record" ⇒
"Approve Purchase Order"). Cover every goal in `project.goals[]` and every `release_scope.in` bullet; every human
actor needs at least one use case, and a S-3.2 batch with no new `use_cases[]` is almost always wrong.

## S-3.3 — Missing Use Case Sweep

Check each theme against the current list. For a theme with no match, decide which it is: a **branch of an
existing use case** (name it in `notes` for S-3.4 to wire as `extends`), or a **goal of its own** (add a use case;
Fast mode: with an `assumptions[]` entry). Name the theme in `notes` with a reason if it does not apply — never
silently skip. **(1) Administration** — an admin actor has view/list + suspend for every entity type end users
create. **(2) Support** — a human actor can reach a "something is wrong, help me" path unless support is
explicitly out of scope. **(3) Notifications** — receiving one is not a use case; the notification actor sits on
the emitting use case (S-3.2). Add one only when the recipient must then decide something, named after the
decision ("Respond to Failed Delivery"); never a passive "Receive …" / "View Notifications". **(4) Account
access** — every human actor has exactly the account use cases its access implies (S-3.2). **(5) Audit log** — an
admin actor can review destructive/high-trust actions, when any exist. **(6) Error handling** — a human actor can
recover from a failed action or validation rejection when the recovery involves a real decision.

## S-3.4 — Use Case Relationships

Set `includes[]`/`extends[]` on use cases already added at S-3.2/S-3.3 — never create a new use case here. Most
use cases stay standalone: wire one only when its definition holds, a wrong one is worse than none.

**What they mean (UML 2.5.1 §18).** `includes` (set on the **base**): the included behaviour **runs every time**
the base runs, as part of it — without it the base is incomplete. `extends` (set on the **extending** use case):
optional behaviour **inserted at a point inside the base's flow** when a condition holds — the base is complete
without it. Neither means time order, screen navigation, a precondition, or "these two are related". One base is
enough for an include; being shared is not a reason to include.

**Ask before every relationship.** (a) Does this behaviour *execute* each time the base runs, or is it a *state* that must already hold
(signed in, has credit, owns a project)? A state is a precondition: write it in the base's description,
never an include.
(b) Does it happen *inside* the base's flow, or would the actor deliberately open the product to do it?
Deliberate ⇒ a goal of its own, standalone, never an extend.
(c) If this relationship were missing, what would a reader misunderstand? Nothing ⇒ leave it out.

**Authentication prerequisite rule.** Log In / Sign In is an access precondition written in the protected use
case's description, never the target of `<<include>>` or `<<extend>>`. Register Account and Reset Password
stay standalone goals, never included/extended because another use case needs an account.

**What goes wrong otherwise.** A use case that has `extends[]`, or is included, is drawn **without its human actor
link**, so a wrong relationship turns a real goal into a subroutine the actor can never start. Wrong: "Place Order
includes Log In" (a state, (a)); "Reset Password extends Log In" (deliberate, (b)). Right: "Apply Discount Voucher
extends Place Order" (optional, inside checkout); "Place Order includes Calculate Shipping Fee" (every order).

Op: `{ "op": "set", "path": "use_cases[id=UC02].includes", "value": ["UC06"], "reason": "…" }`. The `reason` is
shown to the reviewer at the gate: say why (a) or (b) holds, do not restate the relationship. Every referenced id
exists after this batch; no self-reference, no cycles, never both an include and an extend between the same pair.

## S-3.5 — Use Case Descriptions

Finalize `description` for every use case not yet fully worded (one sentence: actor, trigger, outcome). Only an
extending use case opens with its condition ("When …"); every other one starts with the actor. Table shape:
`assets/usecase-table-template.md` — ids are resolved to names at render time, never stored.

## Rules

1. `function_ids` stays `[]` for every use case — functions do not exist until S-4; wiring happens then.
2. New actor/use-case ids continue the existing sequence (`draft-to-ops` rule 5); check the projection.
3. English, no diacritics, no section numbers in prose (`draft-to-ops` rules 6–7).
4. `includes`/`extends` only reference use case ids already present after this batch (own adds count).
5. Fast mode: fill a missing detail with the likeliest default + an `assumptions[]` entry (`status:
   "unconfirmed"`); Coaching mode leaves it for Elicit (`draft-to-ops` rule 10) — except S-3.1 access, which
   in both modes gets the one combined assumption.

## Example (S-3.1, one human actor + role)

```json
{ "ops": [ { "op": "add", "path": "actors[]", "value": { "id": "A01", "name": "Store Manager", "kind": "human", "description": "Runs a single store and needs the day's orders settled before closing." }, "reason": "S-3.1 primary human actor from Brief" }, { "op": "add", "path": "roles[]", "value": { "id": "R01", "name": "Store Manager", "actor_id": "A01" }, "reason": "S-3.1 role for primary actor" } ], "notes": "Primary human actor and matching role added." }
```

## Self-check

- [ ] Every actor has `kind` correct, a product-specific `description`, and a name following A1/A3–A6/A8.
- [ ] Every use case name is verb + object in business terms, shows the actor's value, `function_ids: []`.
- [ ] `actor_ids` lists participants, primary first; notification actors only on emitting use cases; every
      human actor's access decided and its account use cases match; sweep themes covered or ruled out.
- [ ] Every relationship passes (a)/(b) and its `reason` says why; Log In / Sign In is never a target and
      account-access use cases stay standalone; ids exist, no cycles, no double relationship.
