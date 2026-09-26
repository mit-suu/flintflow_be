---
skill_id: apply-change-op
kind: action
version: 1.1.0
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
- Session is pipeline session: {{is_pipeline}}
- Baseline exists: {{has_baseline}}
- Projection around the target (keyed): {{projection}} — `existing_ids` lists the ids that exist right now
- Glossary / proper names: {{glossary}}
- For `reconcile` — the owning step `{{step_id}}` ({{step_name}}), the paths it may write `{{writable_paths}}`, and the stale section with the exact changes that made it stale: {{stale_sections}}

## Change instruction (`change_instruction`)

1. **Locate** the target by key. Resolve names through the projection and glossary: "rename Admin to Administrator" → `actors[id=A03].name`.
2. **Ambiguous?** Several possible targets, or the intent could mean different fields → return `clarification_needed` with **one** short question in the user's language, and no ops.
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
