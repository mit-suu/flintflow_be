---
skill_id: screens-and-flow
kind: content
version: 0.6.1
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

Covers **S-4.1 Screen Inventory** and **S-4.2 Screens Flow** — feeds `fixed:3.1.1`, `fixed:3.1.2` and
every `feature:<id>` section. S-4.1 **fixes N** (the S-5 loop count, step total `50 + 5 × N`), so a screen
missed here costs a whole re-plan. Every rule needed is inlined below.

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
actor and has no "unassigned" part, so a screen outside every actor's journey is a gap. Name the actor(s)
in `description` ("Founder …"). If users sign in, create **one** Login screen shared by every signed-in
actor (its `description` names them all) and give each actor a landing screen — S-4.2 roots every flow at
Login. Pre-auth screens (Login, Forgot/Reset Password, public landing) belong to **every** actor: S-4.3
grants them to `Guest` only, which draws them in each actor's flow.

One `screens[]` row per distinct place the user lands:
`{id, feature_id, name, description, flow_to: [], is_popup, tabs: [], primary_function_id: null,
queue_order, detail_status}`. `description` is one sentence: who is here and what they accomplish.
Rules: every screen belongs to exactly one existing `feature_id`; a modal/dialog is a screen with
`is_popup: true`; a tabbed page is ONE screen with `tabs: [...]`; list and detail are two screens. Include
the unglamorous ones — login, forgot password, onboarding, admin console, settings, notifications — a
missing auth screen is the most common gap. An error or access-denied page is a screen **only** if you can
name the screen that sends the user there (a non-admin opening Admin Console), else a function's abnormal flow.

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
`flow_to` lists screens reachable by a deliberate navigation (button, link, redirect after success). Not:
the browser back button, a global nav bar present everywhere, or an error toast. This step sees only
`features` and `screens`: read each screen's actor(s) from its `description` (named at S-4.1).

**Journey shape — one tree per human actor, rooted at Login:**
1. **Login is the root.** If users sign in, Login is the first screen of every signed-in actor's journey
   and has **no** incoming edge. Pre-auth screens hang off it (`Login → Forgot Password → Reset
   Password`, `Login → First-time Password Setup`), never the reverse.
2. **Login → one landing per actor.** Login's `flow_to` lists each actor's landing screen (role-based
   redirect after sign-in): the page that actor works from most (Manager Dashboard, My Exam Schedule…).
   Actors sharing a landing share the edge. Login never links straight to a deeper screen.
3. **Landing → feature groups.** From the landing, link the entry screen of each feature the actor uses;
   inside a feature go hub/list → detail → popup, keeping a feature's screens together. Cross-feature edges
   only for a real jump (a dashboard alert opening the grade approval list).
4. **Shared screens** (notifications, profile, settings) are linked from each actor's landing, not chained
   through business screens.
Landing/grouping follow the use cases (`assumptions[]` entry when you choose). A public landing page is a
root **beside** Login, never above it (no Landing → Login edge, no incoming edge); no sign-in ⇒ only root.

**One direction only.** `flow_to` records the forward move, away from Login. Never add the return edge —
going back is implicit, even a redirect after success: reset password → login, detail → list, popup →
opener, page → hub, confirm → the page it confirms. Scan every pair: if A lists B and B lists A, delete the
edge that points back toward Login. Ids in `flow_to` must exist after this batch (`dead_reference` otherwise).

**No orphan screens.** Per actor, every screen they use is reachable from the root: every non-popup screen
other than the root has an incoming edge; every popup has an opener; an error / access-denied page gets an
edge from every screen that sends the user there (Admin Console → Access Denied), none ⇒ `remove` it.
A screen that fits no human actor's journey is `remove`d (`screens[id=…]`, cascade takes its functions) with
a `reason` and an `assumptions[]` entry. Yellow flag `orphan_screen` (§3.1.1) catches what slips through;
at sign-off it turns red (`orphan_screen_at_baseline`) and blocks the baseline.

## Rules

1. Ids continue the existing sequence (`draft-to-ops` rule 5) — check the projection before numbering.
2. English values, no diacritics, no section numbers in prose (`draft-to-ops` rules 6–7).
3. Do not touch `use_cases[].function_ids` here; wiring use cases to functions is S-4.4/S-5.
4. `detail_status` is only `pending` or `placeholder` at this step — `in_progress` and `signed_off` are
   set by the S-5 loop, never by you.
5. Still unclear: pick the most reasonable default + an `assumptions[]` entry (`status: "unconfirmed"`).

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
- [ ] Login has no incoming edge and links to each actor's landing; pre-auth screens hang off Login.
- [ ] Per actor, every screen is reachable from Login via landing → feature; every popup has an opener.
- [ ] No pair A ⇄ B in `flow_to`: every return edge (to login, list, hub, opener) is removed.
