---
skill_id: appendix-content
kind: content
version: 0.3.0
description: "S-7 appendix — detail business rules, common requirements, messages, other requirements (mostly derived)"
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 6144
temperature: 0.3
reads:
  - "functions[]"
  - "business_rules[]"
  - "messages[]"
  - "common_requirements[]"
  - "other_requirements[]"
  - "project"
  - "addendum[]"
writes:
  - "business_rules[]"
  - "common_requirements[]"
  - "messages[]"
  - "other_requirements[]"
  - "assumptions[]"
output_schema: opTransaction
language: en
stub: false
---
# Appendix Content

Covers **S-7.1 Business Rules, S-7.2 Common Requirements, S-7.3 Application Messages,
S-7.4 Other Requirements** — feeds `fixed:5.1`, `fixed:5.2`, `fixed:5.3`, `fixed:5.4`. One step writes one
collection; only emit ops for the collection of the current step.

Three of the four are **derived**: the content already exists inside §3, and your job is to lift it into
§5 with a stable id and a back-reference. Inventing new policy here contradicts §3 and is the main way
this phase goes wrong. `references/*.md` are **not loaded at runtime**; rules are inlined.

## S-7.1 — Business rules (`fixed:5.1`)

Source: **`functions[].validations[kind=business]`, and nothing else.** Walk every function in the
projection; each business validation becomes, or joins, a `business_rules[]` row:
`{id, tier: "detail", statement, source_validation_ids: [...]}`.

- `statement`: the rule stated once, product-wide, in the present tense, with no function or screen name
  in it — "A project can be archived only by its owner", not "On the workspace screen the archive button…".
- **Merge duplicates.** The same policy enforced by four functions is ONE row whose
  `source_validation_ids` lists all four validation ids. That list is the traceability edge back to §3;
  an empty `source_validation_ids` on a `tier: "detail"` row means it was invented, not derived.
- `tier: "high"` rows already exist from S-2.4 — do not touch them, and do not duplicate one as `detail`.
- **`source_validation_ids` is the ONLY link back to §3.** This step may not write `functions[]`, so do
  not try to set `functions[].business_rule_ids` here — that field is written at S-5.4 for rules that
  already existed. The traceability edge you are responsible for points from the rule to the validation.
- If a business validation contradicts a high-tier rule, do not silently pick a side: write the detail row
  as stated in §3 and add an `assumptions[]` entry naming the conflict for S-8.4 to resolve.

## S-7.2 — Common requirements (`fixed:5.2`)

The only non-derived step here. `{id, category, statement}` — behaviour that applies across screens rather
than to one function. Sweep these categories and cover the ones that apply (say in `notes` when one does
not): **navigation** (persistent nav, breadcrumb, back behaviour), **feedback** (loading, empty, success
and error states), **forms** (when validation fires, what survives a failed submit, unsaved-changes
warning), **data display** (default sort, page size, date/number/currency format and timezone),
**session** (idle timeout, what happens to unsaved work), **responsiveness** (supported widths, per
`project.form_factor`), **notifications** (in-app vs email, where the history lives).
One rule per row, checkable by a reviewer.

## S-7.3 — Application messages (`fixed:5.3`)

Source: **`functions[].abnormal[]`** (plus the success confirmations `normal[]` implies for destructive or
money-moving actions). Each becomes `{id, code, text, function_ids: [...]}`.

- `code`: `<AREA>-<NNN>`, uppercase, area from the feature ("AUTH-001", "BILL-004", "PROJ-012"). Unique
  across the project; number within the area from 001.
- `text`: what the user actually reads — one sentence, second person, no error-class names, no stack
  vocabulary, and it must say what to do next when there is something to do. "Your credit balance is too
  low to run this step. Add credits to continue."
- **Merge by message, not by function.** The same sentence raised by six functions is ONE row with six
  ids in `function_ids`; that array is the back-reference to §3.
- Every id in `function_ids` must exist after this batch.

## S-7.4 — Other requirements (`fixed:5.4`)

`{id, kind, statement}` with `kind` ∈ `risk` | `assumption` | `open_question` | `technical_risk`.
Two sources: (a) `addendum[]` entries whose `target_section` is `fixed:5.4` — carried over from the Brief
verbatim in meaning, and (b) technical risk visible from what §3/§4 now says: an external dependency with
no fallback, a threshold nobody has validated, a scale assumption, a regulatory question, a migration.
Do not restate the release scope here, and do not turn every unconfirmed assumption into a row — S-9.2
already sweeps `assumptions[]`. Keep this section to things a stakeholder must decide or accept.

## Rules

1. Only the collection of the current step; ids continue the existing sequence (`draft-to-ops` rule 5).
2. Never write `functions[]`, `validations[]` or `nfrs[]` from here — S-7 reads §3, it does not edit it.
   The op validator enforces it: S-7.1 may write only `business_rules` and `assumptions`.
3. Every id in `source_validation_ids` / `function_ids` must exist after this batch (`dead_reference`).
4. English values, no diacritics, no section numbers in prose (`draft-to-ops` rules 6–7).
5. Fast mode: derive the most reasonable row plus an `assumptions[]` entry (`status: "unconfirmed"`);
   Coaching mode leaves the open question for Elicit (`draft-to-ops` rule 10).

## Example (S-7.1 merging one policy enforced twice, then S-7.3)

```json
{
  "ops": [
    { "op": "add", "path": "business_rules[]", "value": { "id": "BR12", "tier": "detail", "statement": "A project can be archived or deleted only by its owner.", "source_validation_ids": ["FN031-V2", "FN034-V1"] }, "reason": "S-7.1 merged from two function validations" },
    { "op": "add", "path": "messages[]", "value": { "id": "M07", "code": "BILL-004", "text": "Your credit balance is too low to run this step. Add credits to continue.", "function_ids": ["FN020", "FN021", "FN044"] }, "reason": "S-7.3 merged from three abnormal flows" }
  ],
  "notes": "No open regulatory question; stakes is production, not regulated."
}
```

## Self-check

- [ ] Every `tier: "detail"` rule has a non-empty `source_validation_ids`; nothing invented here.
- [ ] Duplicate policies merged into one row; `tier: "high"` rows from S-2.4 untouched.
- [ ] Every `abnormal[]` entry of the projection is represented by a message, or explained in `notes`.
- [ ] Message codes are `<AREA>-<NNN>`, unique, and every `function_ids` entry exists.
- [ ] Message `text` is user-facing and says what to do next where an action exists.
- [ ] §5.2 covers navigation, feedback, forms, data display, session, responsiveness, notifications.
