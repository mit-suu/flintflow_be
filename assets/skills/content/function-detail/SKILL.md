---
skill_id: function-detail
kind: content
version: 0.3.0
description: "S-5.2 and S-5.4 per screen — trigger, description, normal/abnormal flows, validations (<= 6 functions per call)"
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 6144
temperature: 0.3
reads:
  - "screens[]"
  - "functions[]"
  - "features[]"
  - "roles[]"
  - "permissions[]"
  - "business_rules[]"
  - "messages[]"
writes:
  - "functions[]"
  - "screens[]"
  - "assumptions[]"
output_schema: opTransaction
language: en
stub: false
---
# Function Detail

Covers the S-5 loop for one screen (or the `@nonscreen` round): **S-5.2 Trigger & Description** and
**S-5.4 Function Details** — feeds every `function:<id>` section of §3. S-5.1 (pick the screen) and S-5.5
(sign-off) are bookkeeping done in code, and S-5.3 is the wireframe renderer; none of them calls you.
`references/{batching,validation-kinds,abnormal-flow-patterns}.md` are **not loaded at runtime** — the
rules are inlined here.

## Batching — read this first

The projection you receive holds **only the functions in scope for this call**, at most six
(`step-runner.service.ts#FUNCTION_BATCH_SIZE`). A screen with 15 functions is drafted in three calls.
Therefore: **emit ops only for `functions[]` ids present in the projection.** Do not invent a function,
do not "finish" one you saw in an earlier call, do not renumber. The other batches are someone else's
turn, and touching them overwrites work already accepted.

## S-5.2 — Trigger and description

For each function in the batch, `set` two fields:

- `trigger`: one sentence naming **who does what, where** — "The author clicks Run on the current step in
  the Project Workspace." For an `@nonscreen` function the trigger is the event and cadence — "Every 5
  minutes." / "The payment gateway POSTs a `payment.succeeded` webhook."
- `description`: one sentence on purpose and outcome — what is true after it succeeds that was not true
  before. Not a restatement of the name, not a UI walkthrough.

Also fix the surroundings while you are here: the actor/role that can invoke it must have a matching
`permissions[]` row (S-4.3); when it does not, record an `assumptions[]` entry rather than writing
permissions yourself. If the screen's `description` turns out to be wrong or empty, `set` it — `screens`
is writable in this step.

## S-5.4 — Flows and validations

For each function in the batch, write three things: `set` for the two string arrays, one `add` per
validation.

**`normal[]`** — the success path, 3–7 numbered-in-order sentences, each one actor-visible step:
actor action → system reaction → next state. Start at the trigger's aftermath, end at the outcome named
in `description`. No implementation detail (no table names, no endpoint paths, no framework words).

**`abnormal[]`** — what else really happens, one sentence each: what goes wrong, what the system does,
what the user is left with. Sweep these six patterns and cover the ones that apply (say in `notes` when
one does not): (1) **invalid input** — a validation fails, the form keeps its values except secrets;
(2) **not found / already gone** — the target was deleted or never existed; (3) **not permitted** — the
role lacks the action, per the S-4.3 matrix; (4) **conflict** — someone else changed it first, or the
same thing is submitted twice; (5) **dependency failure** — an external system (AI provider, payment
gateway, mail, PlantUML) errors or times out, and whether the work is retried, queued or lost;
(6) **limit reached** — quota, credit balance, rate limit, file size. A function with an empty
`abnormal[]` is almost always under-specified; only a pure read with no parameters justifies it.

**`validations[]`** — one `add` op **per rule**, not a `set` on the array: an array whose elements carry
an `id` can only be changed element by element (`op_not_allowed` otherwise). Path
`functions[id=FN001].validations[]`, value `{id, kind, statement}` with `id` prefixed by the function id
(`FN001-V1`). `kind` is exactly one of:

| `kind` | Means | Example statement |
| --- | --- | --- |
| `required` | The field/parameter must be present | "Project name must not be empty." |
| `format` | Shape, type, range or length of a value | "Email must be a syntactically valid address." |
| `business` | A domain rule that could change without the UI changing | "A project can be archived only by its owner." |

`kind: "business"` matters downstream: **S-7.1 derives `business_rules[tier=detail]` from exactly these
rows** via `source_validation_ids`, so a domain rule written as `format` is lost from §5.1. Put the
per-field shape rules in `format`/`required` and the policy in `business`.

Wire the function to rules that already exist by appending to `business_rule_ids` (send the **full array**
— `set` replaces it); do not create `business_rules[]` here, that is S-7.1.

## Rules

1. Only ids in the projection; `set` on existing fields of a function — never `add` a new `functions[]`
   row in S-5. The one `add` you do use is per `validations[]` element (see above).
2. Do not touch `order`, `screen_id`, `feature_id`, `priority` or `detail_status` — the loop and S-9.4 own
   those. `detail_status` in particular is set by code, never by an op you emit.
3. Validation ids unique within the function; never reuse an id for a different statement.
4. English values, no diacritics, no section numbers in prose (`draft-to-ops` rules 6–7).
5. Fast mode: write the most reasonable default flow plus an `assumptions[]` entry
   (`status: "unconfirmed"`); Coaching mode leaves the open question for Elicit (`draft-to-ops` rule 10).

## Example (S-5.4, one function of the batch)

```json
{
  "ops": [
    { "op": "set", "path": "functions[id=FN020].normal", "value": ["The author selects the current step and clicks Run.", "The system reserves the credits the step needs and starts the model call.", "The system streams the draft and applies the resulting changes to the document.", "The system shows the step gate with the accept, revise and regenerate actions."], "reason": "S-5.4 success path" },
    { "op": "set", "path": "functions[id=FN020].abnormal", "value": ["The wallet balance is below the reserved amount: the system cancels the run and shows the top-up prompt.", "The model provider times out: the system releases the reservation, keeps the previous content and offers a retry.", "The document changed in another tab: the system rejects the write and asks the author to reload."], "reason": "S-5.4 abnormal flows" },
    { "op": "add", "path": "functions[id=FN020].validations[]", "value": { "id": "FN020-V1", "kind": "required", "statement": "A step must be selected before Run is enabled." }, "reason": "S-5.4 validation" },
    { "op": "add", "path": "functions[id=FN020].validations[]", "value": { "id": "FN020-V2", "kind": "business", "statement": "A step can be run only when every earlier step of the phase is accepted." }, "reason": "S-5.4 validation" }
  ],
  "notes": "Not-found does not apply: the step is always taken from the open project."
}
```

## Self-check

- [ ] Ops only for function ids present in this batch's projection.
- [ ] Every function has a one-sentence `trigger` naming actor + place (or event + cadence).
- [ ] `normal[]` is 3–7 actor-visible steps ending at the outcome in `description`.
- [ ] `abnormal[]` covers the applicable patterns of the six; exceptions explained in `notes`.
- [ ] Every domain policy is `kind: "business"` so S-7.1 can lift it into §5.1.
- [ ] Validations added one `add` op each on `…validations[]`; ids `<function id>-V<n>` and unique.
- [ ] `business_rule_ids` sent as a full array, and only for rules that already exist.
