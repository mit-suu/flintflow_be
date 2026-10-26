---
skill_id: apply-change-op
kind: action
version: 1.6.0
description: Chat change request → ops (or a clarification); impact query → 3 branches → stale; one-pass reconcile
provider: anthropic
aiModel: claude-haiku-5-5
maxTokens: 8192
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
- Clarifying questions you already asked for this request (answered in the chat above): {{clarification_rounds}}
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
2. **Ambiguous?** Several possible targets, or the intent could mean different fields → return `clarification_needed` with **one** short message in the reply language (the `## Reply language` section at the end of this prompt, Vietnamese when it is absent), and no ops. Several facts missing ⇒ ask them all in that one message, never one per turn.
2a. **Already asked (count above ≥ 1)?** Never ask again about anything the user answered — a short answer ("chỉ thao
   tác xóa", "cả hai") is a full answer. Fill what is left from the projection yourself (which screens have a delete
   action, which actor uses a screen) and return ops; ask again only for a fact the projection cannot give.
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
   A new use case: put in `function_ids` the existing functions from the projection that carry it out.
{{#if use_case_mode=use_case_only}}
   None fits ⇒ leave it empty; screens do not exist yet in this project, do not add any.
{{/if}}
{{#if use_case_ui}}
3e. **New use case ⇒ check it, then add its related parts in the same batch** (exception to rule 3; context in
   `use_case_context`). One use case = one goal: actors with different goals in the request (Student asks for a grade review,
   Lecturer settles it) ⇒ one use case + function per goal, each with only its actor ("Request Grade Review" for Student,
   "Decide Grade Review" for Lecturer); never one use case for both. Same or overlapping goal as a `use_case_context.use_cases` entry
   of that actor (Suspend Student Account vs Deactivate Student Record), user silent ⇒ `clarification_needed` naming it: extend it, replace it, or keep both and how they differ.
   **A request needs someone to settle it — never leave the flow dead-ended.** When the new use case creates something
   another actor must act on (a request, an application, a complaint, a report to approve — "Student requests a grade
   review", "Lecturer submits leave"), the batch MUST also hold the rest of that flow, with all their parts (function,
   screen, `flow_to`, permissions, messages):
   - the use case(s) that **settle** it, one per deciding actor and step ("Decide Grade Review" for Lecturer; "Approve
     Grade Review" for Academic Management Office when the project's actors show an approver for that kind of decision);
   - the requester **following the outcome** when the request has a status ("View Grade Review Status" for Student).
   Pick the deciding actors from `use_case_context` (actors, existing use cases of the same area). Which actor settles it
   is not clear from the request and the project ⇒ `clarification_needed` asking who decides (and whether a second
   approval is needed), `choices` = the candidate actors' names plus a "both, in that order" option — do not guess.
   Every use case of the batch the user did not ask for is a **supporting use case**: list each name in
   `proposed_use_cases`, never silently — a goal the user describes (even unnamed, e.g. "Lecturer regrades it") is
   requested, never listed there. Code shows the user each proposed use case to keep or drop (`ui_plan` drop ⇒ leave it
   and all its parts out). Other supporting use cases that only make the project fit better (a list, a search) stay
   optional: add them only when clearly needed, listed the same way.
   **Several steps** (pick, fill in, confirm) ⇒ one screen per step, chained in order by `flow_to`; `ui_plan` "one screen" ⇒ a single screen for it.
   **The UI of each new use case is the user's call**: its own screen, a popup opened from <screen>, an existing screen, or one screen shared by the new use cases. Never ask about the UI yourself: draft your best proposal (a new screen per step) — code then shows the user every new use case and screen to choose from; ask only for a fact you cannot fill (who receives it, what the user enters, a limit). Follow the answer exactly — `use_case_context.ui_plan` (when present) is that answer per use case: obey every entry; nothing said for one ⇒ its own screen. Then:
   - **the screen or popup the user chose**; when you propose: anything that changes data or takes input gets a new one, an
     existing screen fits a pure read addition (a column, a filter, a read-only field) — never just a button;
   - the new screen: `name`, `description`, `feature_id`, `flow_to`, `tabs`, plus the edge into it — `set
     screens[id=…].flow_to` to the old list plus the new screen on the screen that opens it, so it is reachable;
   - one `permissions[]` row per role of each actor on its screen, shared screen included (`view`, plus `create`/`update`/`delete` it does);
   - the function on that screen (system/time actor ⇒ only a function, `screen_id: null`). Declare temporary ids as
     each added element's own `"id": "$newFn"` / `"id": "$newScreen"`; `$newFn` goes in `function_ids`. Code sets
     `order`, `detail_status`; layout and diagrams are drawn after apply.
{{/if}}
{{#if use_case_mode=screen_pending}}
   The function needs only `name`, `trigger`, `description`, `screen_id`, `feature_id` — the screen loop details it.
{{/if}}
{{#if use_case_mode=full}}
   No later step will describe it ⇒ write the function fully like `sample_function` (Functional Requirements, in
   English): `trigger`, `description`, `normal[]` steps, `abnormal[]` cases, `validations[]` (`kind`, `statement`, no
   id), `business_rule_ids` reused from the context. Say in `notes` (reply language) what the batch adds.
{{/if}}
{{#if messages_ready}}
3f. **Application messages** (§ Messages) for the new function: each user-visible `abnormal[]` case needs a message —
   same meaning as one in `use_case_context.messages` ⇒ `set messages[id=…].function_ids` to its old list plus
   `$newFn`; otherwise `add messages[]` `{ "code": "<AREA>-001", "text": …, "function_ids": ["$newFn"] }` — area
   that fits (an existing one from the context), code fixes the number; text: one sentence saying what to do next.
{{/if}}
3c. **Removing** one element is `remove` with the element path: `remove use_cases[id=UC07]`,
   `remove functions[id=FN005].validations[id=FN005-V2]`. Do not "remove" by setting the array to a shorter
   list — that is how whole elements vanish without a diff line.
3d. **Elements inside an element** (a function's `validations`) are added and removed one by one, exactly the
   same way. Sending the whole `validations` array is accepted but it is read as "make it look like this":
   anything missing from your list is deleted.
{{#if use_case_removal}}
3g. **Removing a use case ⇒ remove what belongs only to it, in the same batch** (mirror of rule 3e; context in
   `use_case_context`). `remove use_cases[id=…]`, then:
   - each of its `function_ids` that no remaining use case lists ⇒ `remove functions[id=…]` (its validations go with it);
   - each screen left with no function after that ⇒ `remove screens[id=…]` — cascade removes its permissions, layout
     and the `flow_to` edges into it;
   - each message whose `function_ids` would hold only removed functions ⇒ `remove messages[id=…]`.
   Anything another use case still uses (a shared function, screen, message, the actors and roles) stays.
   **Use cases of the same flow are the user's call — ask first, never remove them silently**: the removed one is a
   request others settle or follow ("Request Grade Review" ⇒ "Decide Grade Review", "Approve Grade Review", "View Grade
   Review Status"), or it settles a request that would be left without anyone deciding it. The user did not name them
   (nor "the whole flow") ⇒ `clarification_needed` listing them numbered with their actors, `choices` = remove the
   whole flow / remove only the named one / pick one by one. The answer names what to remove ⇒ remove exactly that,
   each with its parts as above. Say in `notes` (reply language) what the batch removes.
{{/if}}
{{#if use_case_edit}}
3h. **Editing a use case ⇒ update what belongs only to it, in the same batch** (like rules 3e / 3g). `use_case_context.
   edit_targets` holds each use case the request names, its functions (full `normal` / `abnormal` / `validations`),
   screens, permissions on them and messages, each with `shared_with` = other use cases using that part.
   **Which use case**: `edit_targets` is empty, or the request could mean another one ⇒ `clarification_needed` asking which,
   `choices` = the candidate use case names exactly as in `use_case_context.use_cases` — never guess, never edit from names
   alone (you need the current values to write a correct `set`).
   By kind of edit:
   - **rename / reword the goal** ⇒ `set use_cases[id=…].name` / `.description`; a function or screen whose name repeats the
     old goal (same words) is renamed to match;
   - **change the actor** ⇒ `set …actor_ids`; one `permissions[]` row per role of the new actor on each of its screens
     (`view`, plus what it does there), `remove permissions[id=…]` of the old actor's roles on screens no other use case of
     that actor uses; the edge into its first screen comes from a screen the new actor's role can view;
   - **change the flow** (add / drop / reword a step, a check, an outcome) ⇒ `set functions[id=…].normal` / `.abnormal`
     with the whole updated list, `add` / `remove` validations one by one, a message for each new user-visible abnormal
     case (rule 3f); a step done by **another actor** (an approval, a review) is a new use case of that actor ⇒ rule 3e;
   - **split / merge** ⇒ each resulting use case keeps one goal (rule 10) with its own function, screen and permissions.
   **Shared parts are the user's call**: a function or screen whose `shared_with` is not empty ⇒ do not change it silently —
   `clarification_needed` naming the other use cases, `choices` = change it for all / give this use case its own copy /
   leave it. Whatever no rule above reaches stays unchanged (rule 8). Say in `notes` (reply language) what changes.
{{/if}}
4. **Cascade** deletes in the same batch (`draft-to-ops/references/invariants.md`). If the change necessarily breaks an invariant (e.g. deleting the last screen), return `clarification_needed` explaining what blocks it.
5. **Proper names** with a key (actor, entity, screen, glossary term) change in one place — do not also edit prose that mentions them; S-8.4 Consistency Pass catches prose.
6. **English** values for SRS content; `reason` in the reply language — it becomes the §I Record of Changes line.
7. **Never emit** ops on `flags[]`, `baselines[]`, `usage[]`, `steps[]`, `progress` or `sessions[]`.
8. **Only touch what the request names** (only exceptions: supporting use cases of rule 3e, listed in `proposed_use_cases`; the parts of a removed use case, rule 3g; the parts of an edited use case, rule 3h). An element the user did not mention must come out of this batch
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
13. **`empty_collections`** in the projection = the named section has nothing yet: `add` into its `add_path` with exactly
   its `fields`, never into a look-alike collection (§5.2 Common Requirements is `common_requirements[]`, not `nfrs[]`).

## Reconcile (`reconcile`)

User clicked **Reconcile** once for all `stale` sections (UC 6.10). For each stale section:

- One call per stale section: `{{projection}}` is the owning step's own projection (its `reads`), nothing else.
- Read **only** the dependent fields that changed (`stale_sections[0].changes`).
- Propose ops that bring the owned fields back in line with those changes, e.g. a renamed actor that still appears in `use_cases[].description`.
- Do not touch sections that are not stale. Diagrams with a mismatched `source_hash` are re-rendered by code, not by you.
- Stay inside `{{writable_paths}}`; ops on other roots are rejected by the op validator before the user ever sees them.
- Nothing to bring back in line ⇒ return `{"ops": []}`. An empty batch is a valid answer, not a failure.
- Output `opTransaction`. The user sees ONE merged preview diff for all sections; a rejected diff leaves every section `stale` — that is valid, and nothing is retried automatically.

## Branches (code applies — for your awareness; detail in `references/impact-branches.md`)

Nothing references the change ⇒ applied silently; dependents ⇒ preview diff, then they turn `stale`; baseline ⇒ Impact Analysis mandatory; broken invariant ⇒ whole batch rejected. **No auto-propagation**: changing §2.1 only makes §2.2 `stale`. Only exception: rule 3e (new use case).

## Output

Return **only** JSON, no fence, no commentary.

`change_instruction`:

```json
{ "clarification_needed": "Bạn muốn đổi tên vai trò 'Admin' hay actor 'System Admin'?", "choices": ["Vai trò Admin", "Actor System Admin"] }
```

```json
{
  "ops": [
    { "op": "set", "path": "actors[id=A03].name", "value": "Administrator", "reason": "đổi tên theo yêu cầu" }
  ],
  "notes": "optional short summary for the preview card, in the reply language"
}
```

Supporting use cases you added beyond the request (rule 3e): also return their names, e.g. for "add Request Grade Review
for Student" → `"proposed_use_cases": ["Decide Grade Review", "View Grade Review Status"]`.

Who settles a request is unknown (rule 3e) ⇒ ask instead of drafting:

```json
{ "clarification_needed": "Ai xử lý yêu cầu phúc khảo điểm: giảng viên chấm lại, phòng đào tạo duyệt, hay cả hai theo thứ tự đó?", "choices": ["Lecturer", "Academic Management Office", "Lecturer rồi Academic Management Office duyệt"] }
```

`reconcile`: `{ "ops": [...], "notes": "..." }` — same op grammar as `draft-to-ops`.
