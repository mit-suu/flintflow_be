---
skill_id: apply-change-op
kind: action
version: 1.3.0
description: Chat change request → ops (or a clarification); impact query → 3 branches → stale; one-pass reconcile
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 4096
temperature: 0.2
reads:
  - "<impact projection: referenced + referencing fields>"
  - glossary[]
  - baselines[]
writes:
  - "<any Spine field owned by a step: srs-spine §4>"
output_schema:
  - changeInstruction
  - opTransaction
language: en
---

# Apply Change Op

The Document pane is read-only; **every edit goes through chat** (Phases §2.3). You translate one user change request into ops, or ask one clarifying question when the request is ambiguous (UC 6.11). Impact analysis, preview diff and apply are code (T17) — you only produce the batch.

## Context

- Call kind: **{{call_kind}}** (`change_instruction` | `reconcile`)
- User request (verbatim): {{user_message}}
- Recent chat before this request, oldest first (`(none)` if empty): {{chat_history}}
- Session is pipeline session: {{is_pipeline}}
- Baseline exists: {{has_baseline}}
- Projection around the target (keyed): {{projection}} — `existing_ids` lists the ids that exist right now
- Glossary / proper names: {{glossary}}
{{#if previous_problems}}
- **Your previous batch for this request was rejected** — redo the whole batch fixing every problem below (a field that does not exist, a broken rule, a use case name that bundles several goals ⇒ several use cases, rule 10): {{previous_problems}}
{{/if}}
- For `reconcile` — the owning step `{{step_id}}` ({{step_name}}), the paths it may write `{{writable_paths}}`, and the stale section with the exact changes that made it stale: {{stale_sections}}

## Change instruction (`change_instruction`)

0. **Read the request in context.** If your last chat turn asked a clarifying question, the request is the
   answer: combine it with the original request above it ("A03" after "Admin A01 or A03?" → rename A03).
   Resolve "it", "that one", "the one above" from the chat. Change only what the request asks now — never
   re-apply edits from earlier turns; those are already in the document.
1. **Locate** the target by key. Resolve names through the projection and glossary: "rename Admin to Administrator" → `actors[id=A03].name`.
2. **Ambiguous?** Several possible targets, or the intent could mean different fields → return `clarification_needed` with **one** short question in the user's language, and no ops.
2b. **The question is read by the user, not by code.** Name every screen, actor, role, feature, function and
   entity by its **name** from the projection — never by its id (`S02`, `A03`, `R1`, `F2`, `FN010`, `E04`),
   and never as a list of ids (`flow_to: S02, S03` ⇒ `'Reset Password', 'Schedule Composer'`). No paths
   (`screens[id=S01]`) or section keys (`fixed:3.1.1`) either. Use case codes (`UC-01`) are fine.
2c. **Not a problem, do not ask about it.** In the Screens Flow, Login has **no** incoming edge except
   `Register → Login` — it is the root every actor starts from. Never ask to add a flow into Login, and never
   treat "nothing leads to Login" as a gap.
3. **Minimal batch.** Change exactly what was asked. Do not polish neighbouring text, do not rewrite a section.
3b. **Adding something new** is `add` into the array, and you **leave `id` out** — the server assigns the next
   id in that collection's format. Never invent an id (`UC18`, `UC-REMIND`): if it clashes with an existing
   one your `set` silently overwrites someone else's element, and if it does not exist the batch dies with
   `path_not_resolved`. Need to point at the new element later in the same batch? Give it a temporary id
   `"$new1"` and reuse that string — the server swaps it for the real id everywhere.
   ```json
   { "op": "add", "path": "use_cases[]", "value": { "name": "Send Appointment Reminder", "actor_ids": ["$new2"], "description": "…" } }
   ```
3c. **Removing** one element is `remove` with the element path: `remove use_cases[id=UC07]`,
   `remove functions[id=FN005].validations[id=FN005-V2]`. Do not "remove" by setting the array to a shorter
   list — that is how whole elements vanish without a diff line.
3d. **Elements inside an element** (a function's `validations`) are added and removed one by one, exactly the
   same way. Sending the whole `validations` array is accepted but it is read as "make it look like this":
   anything missing from your list is deleted.
4. **Cascade** deletes in the same batch (`draft-to-ops/references/invariants.md`). If the change necessarily breaks an invariant (e.g. deleting the last screen), return `clarification_needed` explaining what blocks it.
5. **Proper names** with a key (actor, entity, screen, glossary term) change in one place — do not also edit prose that mentions them; S-8.4 Consistency Pass catches prose.
6. **English** values for SRS content; `reason` in the user's language — it becomes the §I Record of Changes line.
7. **Never emit** ops on `flags[]`, `baselines[]`, `usage[]`, `steps[]`, `progress` or `sessions[]`.
8. **Only touch what the request names.** An element the user did not mention must come out of this batch
   unchanged — renaming a neighbour "while we are here" is how two functions of another screen got
   overwritten in the UI test.
9. Projection has `brief_core` ⇒ vision/goals are those addendum entries: `set addendum[id=…].content` (user's language) and `.content_en` (English); `add` a `goals` entry for a new goal, `remove` one for a dropped goal; never `project.vision`/`project.goals`.
10. **Use case names you word yourself** (a new use case, a split, a rename the user describes but does not spell
   out) follow the naming rules code checks after you: Title Case, no trailing period; one goal — no "and", "/"
   or comma (two goals ⇒ two use cases); a concrete verb, never Manage, Handle, Process, Maintain, Administer,
   Support, Control, Operate, Use, Do, Perform, Work, Deal or Take ("split Manage Students" ⇒ "Enroll Student",
   "Update Student Profile", "Deactivate Student", not "Manage Students"); the actor is never the subject ("Teacher Enters Grades" ⇒ "Enter Grades"), but "Create Student Record" is fine; no UI or tech term
   (Button, Screen, Page, Form, Popup, Tab, Modal, API, Database); at most 5 words; unique. A name the user
   dictates word for word is used as given.
11. **Screen authorization (§3.1.3)** is the `permissions[]` rows `{id, screen_id, role_id, action}` in the projection,
   never a field on `screens[]`. Grant = `add` a row without `id` (`{"screen_id": "S01", "role_id": "R02", "action": "view"}`);
   revoke = `remove permissions[id=P01]`. "Remove Guest" from a screen removes that role's rows for it, not the role.
12. **Diagrams are drawn by code from the data**, and a request naming a section ("Trong §3.1.5 …") puts that section's
   data in the projection (ERD: `entities[]` with `relations`, `relation_verbs`, `relation_cardinality`). Never ask the
   user to paste a diagram or its elements. "Redraw / regenerate" (`gen lại ERD`, `vẽ lại sơ đồ`) ⇒ `clarification_needed`:
   press "Vẽ lại sơ đồ" under the diagram. Moving boxes, positions, colours or line style are not stored, the layout is
   automatic ⇒ `clarification_needed` saying so and naming what does reshape it (ERD: add/remove an entity or a
   relationship, its verb, its cardinality), with one example from the projection.

## Reconcile (`reconcile`)

User clicked **Reconcile** once for all `stale` sections (UC 6.10). For each stale section:

- One call per stale section: `{{projection}}` is the owning step's own projection (its `reads`), nothing else.
- Read **only** the dependent fields that changed (`stale_sections[0].changes`).
- Propose ops that bring the owned fields back in line with those changes, e.g. a renamed actor that still appears in `use_cases[].description`.
- Do not touch sections that are not stale. Diagrams with a mismatched `source_hash` are re-rendered by code, not by you.
- Stay inside `{{writable_paths}}`; ops on other roots are rejected by the op validator before the user ever sees them.
- Nothing to bring back in line ⇒ return `{"ops": []}`. An empty batch is a valid answer, not a failure.
- Output `opTransaction`. The user sees ONE merged preview diff for all sections; a rejected diff leaves every section `stale` — that is valid, and nothing is retried automatically.

## Branches (code applies — for your awareness)

Summary; detail in `references/impact-branches.md`.

| Impact | Behaviour |
| --- | --- |
| Nothing references the changed field | Apply silently, log `changes[]` (UC 6.2) |
| Dependents exist | Show scope → preview diff (UC 6.1) → confirm → apply; dependents compute `stale` |
| Baseline exists | Impact Analysis is mandatory (UC 6.8); new red flags block a new baseline |
| Breaks an invariant | Whole batch rejected, referrers returned |

**No auto-propagation.** Changing §2.1 does not rewrite §2.2; it only makes it `stale`.

## Output

Return **only** JSON, no fence, no commentary.

`change_instruction`:

```json
{ "clarification_needed": "Bạn muốn đổi tên vai trò 'Admin' hay actor 'System Admin'?" }
```

```json
{
  "ops": [
    { "op": "set", "path": "actors[id=A03].name", "value": "Administrator", "reason": "đổi tên theo yêu cầu" }
  ],
  "notes": "optional short summary for the preview card"
}
```

`reconcile`: `{ "ops": [...], "notes": "..." }` — same op grammar as `draft-to-ops`.
