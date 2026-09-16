---
skill_id: screens-and-flow
kind: content
version: 0.3.0
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

**2. Screens.** One `screens[]` row per distinct place the user lands:
`{id, feature_id, name, description, flow_to: [], is_popup, tabs: [], primary_function_id: null,
queue_order, detail_status}`. `description` is one sentence: who is here and what they accomplish.
Rules: every screen belongs to exactly one `feature_id` that exists after this batch; a modal/dialog is a
screen with `is_popup: true`; a tabbed page is ONE screen with `tabs: ["Overview", "Members"]`, not one
screen per tab; list and detail of the same entity are two screens. Include the unglamorous ones — login,
sign-up, forgot password, empty state/onboarding, error/permission-denied, admin console, settings,
notifications, plan & pricing — a missing auth screen is the most common gap.

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
Every non-popup screen should be reachable from at least one other screen or be an entry point (login,
landing); a screen nothing flows to is a dead end worth an `assumptions[]` note. Popups flow back to their
opener implicitly — do not add the return edge. Ids in `flow_to` must exist after this batch
(`dead_reference` otherwise).

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
    { "op": "add", "path": "screens[]", "value": { "id": "S05", "feature_id": "F2", "name": "Project Workspace", "description": "Where the author drives the guided pipeline and reviews the generated document.", "flow_to": [], "is_popup": false, "tabs": ["Document", "Verification"], "primary_function_id": null, "queue_order": 1, "detail_status": "pending" }, "reason": "S-4.1 core screen" },
    { "op": "add", "path": "functions[]", "value": { "id": "FN020", "screen_id": "S05", "feature_id": "F2", "order": 0, "name": "Run Pipeline Step", "trigger": "", "description": "", "normal": [], "abnormal": [], "validations": [], "business_rule_ids": [], "priority": null }, "reason": "S-4.1 function frame" },
    { "op": "set", "path": "screens[id=S05].primary_function_id", "value": "FN020", "reason": "S-4.1 primary function for the wireframe" }
  ],
  "notes": "Core screen S05 stays pending for S-5; the remaining screens of F2 are placeholders."
}
```

## Self-check

- [ ] Every screen has a `feature_id` that exists, and every feature has at least one screen.
- [ ] Auth, admin, settings, notifications and error screens are present or explicitly out of scope.
- [ ] Exactly 3–5 screens are `pending`; every other screen is `placeholder` with an assumption.
- [ ] `queue_order` is unique and starts at 1; `progress.screen_queue` lists every screen in that order.
- [ ] Every screen has ≥ 1 function with unique `order` inside its feature, and a `primary_function_id`.
- [ ] S-4.2 only sets `flow_to`/`is_popup`/`tabs`; every id in `flow_to` exists.
