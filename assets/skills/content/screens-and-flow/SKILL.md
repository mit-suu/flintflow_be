---
skill_id: screens-and-flow
kind: content
version: 0.8.0
description: "S-4.1–S-4.2 feature & screen inventory (fixes N and screen_queue), screens flow"
provider: anthropic
aiModel: claude-haiku-5-5
maxTokens: 16384
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
  - "use_cases[]"
  - "progress"
  - "assumptions[]"
output_schema: opTransaction
language: en
stub: false
---
# Screens And Flow

Covers **S-4.1 Screen Inventory** and **S-4.2 Screens Flow** - feeds `fixed:3.1.1`, `fixed:3.1.2` and every `feature:<id>`
section. S-4.1 **fixes N** (S-5 loop count, step total `50 + 5 × N`), so a missed screen costs a re-plan. All rules are inlined below.

## S-4.1 - Features, screens, screen_queue

Work in this order, all in one batch.

**1. Features.** One `features[]` row per coherent capability area a user would name out loud ("Authentication",
"Project Workspace", "Billing"), `{id, name, order}` with `order` starting at 0 and unique inside the project. Derive them
from `project.goals[]` and `release_scope.in`, not from the UI - a feature is a capability, a screen is a place. 4–8
features is typical; one feature holding every screen means the split was skipped.

**2. Screens - actor by actor, no orphans.** Walk each human actor's journey (`use_cases[].actor_ids` with `kind: human`) from
their entry point (landing, login, deep link) through every screen their use cases need. A screen exists **only** if a human
actor uses it; `system`/`time` actors (gateway, LLM provider, scheduler) get **no** screens - their work is a non-screen function
(S-4.4). Name the actor(s) in `description`. If users sign in: **one** Login screen shared by every signed-in actor (its
`description` names them all), a landing screen per actor; pre-auth screens (Login, Register, Forgot/Reset Password, public
landing) belong to every actor (S-4.3 grants them to `Guest`).

One `screens[]` row per page or dialog the user lands on: `{id, feature_id, name, description, flow_to: [], is_popup,
tabs: [], primary_function_id: null, queue_order, detail_status}`, in exactly one existing `feature_id`. `description` is one
sentence: who is here and what they accomplish. The Screens Flow (FPT template §3.1.1) draws exactly these rows, so:
- **`name` = the page as titled on screen**, a noun phrase: `Appointment List`, `Appointment Details`, `Add Appointment`,
  `Doctor Dashboard`, `Login`. Never two jobs joined by "and" / "&" / "or" (`Checkout and Refund` ⇒ `Checkout` + `Refund
  Request`), never a feature name or a catch-all (`Administration Console`, `Booking Management`) ⇒ list its pages instead.
- **Granularity**: a record a user manages gets its list, its details and its add/edit form as separate screens; a feature
  with one screen means pages were merged. Include login, forgot password, onboarding, settings, notifications.
- **Pop-up** (`is_popup: true`) for a dialog opened over a page: confirm / cancel / delete, quick add, import, preview
  (`Cancel Appointment`, `Import Orders`). **Tabs**: one page showing several groups of one record is ONE screen with
  `tabs: [...]` (`Order Details` with `Products Info`, `Receiver Info`), not one screen per group.
- An error / access-denied page only if you can name the screen sending the user there, else a function's abnormal flow.

**3. Core screens and `queue_order`.** Number `queue_order` from 1 in the order a user meets the screens, core screens first.
**Only 3–5 screens get full detail in S-5** (Phases §9.1): the ones carrying the product's own value, not CRUD chrome - give
them `detail_status: "pending"` and the lowest `queue_order`. Every other screen gets `"placeholder"` in this batch (keeps its
row, feature and `functions[]` frame, skips S-5.2…S-5.5) plus an `assumptions[]` entry naming why, with
`path: "screens[id=<screen>].detail_status"` (retired once S-5 details it).

**4. `functions[]` frame.** Each screen gets ≥ 1 `functions[]` row now - the action it exists for: `{id, screen_id, feature_id,
order, name: verb + object, trigger: "", description: "", normal: [], abnormal: [], validations: [], business_rule_ids: [],
priority: null}`; `order` from 0, unique **within the feature** (invariant 5); empty values are correct, S-5 fills them. Set
`screens[].primary_function_id` to that main function (S-5.3 draws a wireframe only for screens that have one). **Wire it to
its use cases in the same batch**: `{"op": "add", "path": "use_cases[id=UC05].function_ids[]", "value": "FN001"}` (appends;
never `set` the array); several use cases may share one function. Every use case of a human actor ends this batch with ≥ 1 function.

**5. `progress.screen_queue`.** Set it to every screen id in `queue_order` order, `pending` screens first:
`{ "op": "set", "path": "progress.screen_queue", "value": ["S01", "S02", …] }`. This is what S-5.1 walks.

## S-4.2 - Flow

Set `flow_to[]`, `is_popup` and `tabs[]` on screens that already exist - **never add a screen here**.
`flow_to` lists edges `{ "to": "<screen id>", "trigger": "<user action>", "guard": "<condition>" }` for deliberate navigation
(button, link, redirect after success) - not the back button, a global nav bar or an error toast. Read each screen's actor(s)
from its `description`. **Every edge has a `trigger`**: a short verb phrase as on the button (`Click Register`, `Submit
credentials`), kept with the flow (not drawn on the diagram). **`guard` only when one action leads to different screens by a condition**
(`OTP valid`): give those edges the SAME `trigger` and a `guard` on all but at most one (that one is the `else`). No
brackets in `guard`; one edge per target. Write with `add` `screens[id=…].flow_to[]` or `set` the array of edges.

**Journey shape - one tree per human actor, rooted at Login:**
1. **Login is the root.** If users sign in, Login is the first screen of every signed-in actor's journey;
   its only incoming edge is `Register → Login`. Register (sign-up) is a root **beside** Login that leads
   to it - never `Login → Register`. Other pre-auth screens hang off Login (`Login → Forgot Password`).
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

**One direction only.** `flow_to` records the forward move, away from Login. Never add the return edge -
going back is implicit, even a redirect after success: reset password → login, detail → list, popup →
opener, page → hub, confirm → the page it confirms. Scan every pair: if A lists B and B lists A, delete the
return edge - for Register ⇄ Login keep `Register → Login`. Ids in `flow_to` must exist (`dead_reference`).

**No orphan screens.** Per actor, every screen they use is reachable from the root: every non-popup screen
other than the root has an incoming edge; every popup has an opener; an error / access-denied page gets an
edge from every screen that sends the user there (Admin Console → Access Denied), none ⇒ `remove` it.
A screen that fits no human actor's journey is `remove`d (`screens[id=…]`, cascade takes its functions) with
a `reason` and an `assumptions[]` entry. Yellow flag `orphan_screen` (§3.1.1) catches what slips through;
at sign-off it turns red (`orphan_screen_at_baseline`) and blocks the baseline.

## Rules

1. Ids continue the existing sequence (`draft-to-ops` rule 5) - check the projection before numbering.
2. English values, no diacritics, no section numbers in prose (`draft-to-ops` rules 6–7).
3. Screen functions are wired to use cases here (step 4); S-4.4 wires only non-screen functions, S-5 none.
4. `detail_status` is only `pending` or `placeholder` at this step - `in_progress` and `signed_off` are
   set by the S-5 loop, never by you.
5. Still unclear: pick the most reasonable default + an `assumptions[]` entry (`status: "unconfirmed"`).

## Example (S-4.1, one feature + one core screen + its function)

```json
{
  "ops": [
    { "op": "add", "path": "features[]", "value": { "id": "F2", "name": "Project Workspace", "order": 1 }, "reason": "S-4.1 feature from release scope" },
    { "op": "add", "path": "screens[]", "value": { "id": "S05", "feature_id": "F2", "name": "Project Workspace", "description": "Where the Founder drives the guided pipeline and reviews the generated document.", "flow_to": [], "is_popup": false, "tabs": ["Document", "Verification"], "primary_function_id": null, "queue_order": 1, "detail_status": "pending" }, "reason": "S-4.1 core screen" },
    { "op": "add", "path": "functions[]", "value": { "id": "FN020", "screen_id": "S05", "feature_id": "F2", "order": 0, "name": "Run Pipeline Step", "trigger": "", "description": "", "normal": [], "abnormal": [], "validations": [], "business_rule_ids": [], "priority": null }, "reason": "S-4.1 function frame" },
    { "op": "set", "path": "screens[id=S05].primary_function_id", "value": "FN020", "reason": "S-4.1 primary function for the wireframe" },
    { "op": "add", "path": "use_cases[id=UC03].function_ids[]", "value": "FN020", "reason": "S-4.1 wire the use case it serves" }
  ],
  "notes": "Core screen S05 stays pending for S-5; the remaining screens of F2 are placeholders."
}
```

## Self-check

- [ ] Every screen has a `feature_id` that exists, and every feature has at least one screen.
- [ ] Every name is one page (noun phrase, no "and", no feature / catch-all name); records have list + details + form; dialogs are pop-ups, record groups are tabs.
- [ ] Auth, admin, settings, notifications screens are present or out of scope; an error page only with a named screen leading to it.
- [ ] Exactly 3–5 screens are `pending`, the rest `placeholder` with an assumption; `queue_order` is unique from 1 and `progress.screen_queue` lists every screen in that order.
- [ ] Every screen has ≥ 1 function (unique `order` in its feature) and a `primary_function_id`; every human actor's use case lists ≥ 1 function.
- [ ] Every screen is used by a human actor (none for a `system`/`time` actor); S-4.2 never adds a screen.
- [ ] S-4.2 sets only `flow_to`/`is_popup`/`tabs`; every `flow_to[].to` exists and has a `trigger`; `guard` only on branches of one shared trigger.
- [ ] Login's only incoming edge is `Register → Login`, it links to each actor's landing; every screen is reachable from it, every popup has an opener.
- [ ] No pair A ⇄ B in `flow_to`: every return edge (to login, list, hub, opener) is removed.
