---
skill_id: screens-and-flow
kind: content
version: 0.5.0
description: "S-4.1–S-4.2 feature & screen inventory (fixes N and screen_queue), screens flow"
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 6144
temperature: 0.3
reads:
  - "features[]"
  - "screens[]"
  - "use_cases[]"
  - "functions[]"
  - "addendum[]"
writes:
  - "features[]"
  - "screens[]"
  - "functions[]"
  - "progress"
  - "assumptions[]"
output_schema: opTransaction
language: en
stub: false
---
# Screens And Flow

Covers **S-4.1 Screen Inventory** and **S-4.2 Screens Flow** — feeds `fixed:3.1.1` (Screens Flow),
`fixed:3.1.2` (Screen Descriptions) and every `feature:<id>` section. S-4.1 is the step that **fixes N**
(the loop count for S-5): after it, the progress bar shows a percentage and the step total `51 + 5 × N`
stops moving, so a screen missed here costs a whole re-plan. `references/*.md` are **not loaded at
runtime** — every rule needed to draft correctly is inlined below.

## S-4.1 — Features, screens, screen_queue

Work in this order, all in one batch.

**1. Features.** One `features[]` row per coherent capability area a user would name out loud
("Authentication", "Project Workspace", "Billing"), `{id, name, order}` with `order` starting at 0 and
unique inside the project. Derive them from `project.goals[]` and `release_scope.in`, not from the UI —
a feature is a capability, a screen is a place. 4–8 features is typical; one feature holding every screen
means the split was skipped.

**2. Screens — actor by actor, no orphans.** Build the inventory from the human actors in the projection
(`use_cases[].actor_ids` whose actor is `kind: human`), one actor at a time: walk that actor's journey from
their entry point (landing, login, deep link) through every screen their use cases need. A screen exists
**only** if at least one human actor who interacts directly with the UI uses it — a screen no human actor
lands on is an orphan and must not be created. `system`/`time` actors (gateway, LLM provider, scheduler)
get **no** screens; their work is a non-screen function (S-4.4). The Screens Flow is drawn once per human
actor, so an actor with use cases but no screen, or a screen outside every actor's journey, shows up as a
gap. Name the actor(s) in `description` ("Founder …", "Administrator …").

One `screens[]` row per distinct place the user lands:
`{id, feature_id, name, description, flow_to: [], is_popup, tabs: [], primary_function_id: null,
queue_order, detail_status}`. `description` is one sentence: who is here and what they accomplish.
Rules: every screen belongs to exactly one `feature_id` that exists after this batch; a modal/dialog is a
screen with `is_popup: true`; a tabbed page is ONE screen with `tabs: ["Overview", "Members"]`, not one
screen per tab; list and detail of the same entity are two screens. Include the unglamorous ones a human actor
really uses — login, sign-up, forgot password, empty state/onboarding, admin console, settings,
notifications, plan & pricing — a missing auth screen is the most common gap. An error or access-denied
page is a screen **only** if you can name the screen that sends the user there (a non-admin opening Admin
Console); otherwise it is an abnormal flow of a function, not a screen.

**3. Core screens and `queue_order`.** Number `queue_order` from 1 in the order a user meets the screens,
core screens first. **Only 3–5 screens get full detail in S-5** (Phases §9.1): the ones carrying the
product's own value, not CRUD chrome. Give those `detail_status: "pending"` and the lowest
`queue_order`. Every other screen gets `detail_status: "placeholder"` in this same batch — it keeps its
row, its feature and its `functions[]` frame, it just skips S-5.2…S-5.5. Marking a screen `placeholder`
here is a decision, so add an `assumptions[]` entry naming why it was left out.

**4. `functions[]` frame.** Each screen gets at least one `functions[]` row now — the action that screen
exists for: `{id, screen_id, feature_id, order, name: verb + object, trigger: "", description: "",
normal: [], abnormal: [], validations: [], business_rule_ids: [], priority: null}`. `order` starts at 0
and is unique **within the feature** (invariant 5). Empty strings/arrays are correct here; S-5 fills them.
Set `screens[].primary_function_id` to the id of that main function — S-5.3 renders a wireframe only for
screens that have one.

**5. `progress.screen_queue`.** Set it to every screen id in `queue_order` order, `pending` screens first:
`{ "op": "set", "path": "progress.screen_queue", "value": ["S01", "S02", …] }`. This is what S-5.1 walks.

## S-4.2 — Flow

Set `flow_to[]`, `is_popup` and `tabs[]` on screens that already exist — **never add a screen here**.
`flow_to` lists screens reachable by a deliberate navigation from this one (button, link, redirect after
success). Not: the browser back button, a global nav bar present everywhere, or an error toast.
**One direction only.** `flow_to` records the forward move of the journey, away from the actor's entry
screen. Never add the return edge — going back is implicit, even a redirect after success: reset or forgot
password → login, register → login, detail → list, popup → opener, page → hub, confirm → the page it
confirms. Before answering, scan every pair: if A lists B and B lists A, delete the edge that points back
toward the entry screen. Ids in `flow_to` must exist after this batch (`dead_reference` otherwise).

**No orphan screens.** Draw the flow per human actor: from each actor's entry screen, every screen that
actor uses must be reachable through `flow_to`. This step sees only `features` and `screens`, so read the
actor from each screen's `description` (named at S-4.1). So:
- every non-popup screen has an incoming edge or is an entry point (login, landing, the page an actor
  lands on after sign-in) — and an entry point still flows onward;
- every popup has at least one opener (a screen whose `flow_to` contains it);
- a sub-area (admin console, settings) is entered from somewhere: link its hub from the actor's landing
  page and link every page of the area from the hub (no edge back to the hub);
- an error / access-denied page gets an incoming edge from every screen that can send the user there
  (Admin Console → Access Denied); no such screen ⇒ `remove` the page, it is an abnormal flow;
- no screen is left with neither an incoming nor an outgoing edge.
If a screen cannot be placed on any human actor's journey, it should not exist: `remove` it
(`screens[id=…]`, cascade takes its functions) with a `reason`, and add an `assumptions[]` entry saying
why — do not leave it dangling. Yellow flag `orphan_screen` (§3.1.1) catches whatever slips through, and
at sign-off it turns red (`orphan_screen_at_baseline`) and blocks the baseline.

## Rules

1. Ids continue the existing sequence (`draft-to-ops` rule 5) — check the projection before numbering.
2. English values, no diacritics, no section numbers in prose (`draft-to-ops` rules 6–7).
3. Do not touch `use_cases[].function_ids` here; wiring use cases to functions is S-4.4/S-5.
4. `detail_status` is only `pending` or `placeholder` at this step — `in_progress` and `signed_off` are
   set by the S-5 loop, never by you.
5. Fast mode: choose the most reasonable default and add an `assumptions[]` entry
   (`status: "unconfirmed"`); Coaching mode leaves the open question for Elicit (`draft-to-ops` rule 10).

## Example (S-4.1, one feature + one core screen + its function)

```json
{
  "ops": [
    { "op": "add", "path": "features[]", "value": { "id": "F2", "name": "Project Workspace", "order": 1 }, "reason": "S-4.1 feature from release scope" },
    { "op": "add", "path": "screens[]", "value": { "id": "S05", "feature_id": "F2", "name": "Project Workspace", "description": "Where the Founder drives the guided pipeline and reviews the generated document.", "flow_to": [], "is_popup": false, "tabs": ["Document", "Verification"], "primary_function_id": null, "queue_order": 1, "detail_status": "pending" }, "reason": "S-4.1 core screen" },
    { "op": "add", "path": "functions[]", "value": { "id": "FN020", "screen_id": "S05", "feature_id": "F2", "order": 0, "name": "Run Pipeline Step", "trigger": "", "description": "", "normal": [], "abnormal": [], "validations": [], "business_rule_ids": [], "priority": null }, "reason": "S-4.1 function frame" },
    { "op": "set", "path": "screens[id=S05].primary_function_id", "value": "FN020", "reason": "S-4.1 primary function for the wireframe" }
  ],
  "notes": "Core screen S05 stays pending for S-5; the remaining screens of F2 are placeholders."
}
```

## Self-check

- [ ] Every screen has a `feature_id` that exists, and every feature has at least one screen.
- [ ] Auth, admin, settings, notifications screens are present or explicitly out of scope; an error page
      exists only with a named screen leading to it.
- [ ] Exactly 3–5 screens are `pending`; every other screen is `placeholder` with an assumption.
- [ ] `queue_order` is unique and starts at 1; `progress.screen_queue` lists every screen in that order.
- [ ] Every screen has ≥ 1 function with unique `order` inside its feature, and a `primary_function_id`.
- [ ] Every screen is used by at least one human actor; no screen exists for a `system`/`time` actor.
- [ ] S-4.2 only sets `flow_to`/`is_popup`/`tabs` (or removes an unplaceable orphan); every id in `flow_to` exists.
- [ ] Per human actor, every screen they use is reachable from their entry screen; every popup has an
      opener; no screen has zero incoming and zero outgoing edges.
- [ ] No pair A ⇄ B in `flow_to`: every return edge (to login, list, hub, opener) is removed.
