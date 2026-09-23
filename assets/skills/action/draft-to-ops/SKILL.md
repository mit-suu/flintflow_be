---
skill_id: draft-to-ops
kind: action
version: 1.0.0
description: Turn the user's answers into ONE Spine op transaction — validated by schema, invariants checked at end of batch
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 6144
temperature: 0.2
reads:
  - "<phase-intake projection>"
  - addendum[]
  - assumptions[]
writes:
  - "<fields owned by the current step: srs-spine §4>"
  - assumptions[]
output_schema: opTransaction
language: en
---

# Draft to Ops

You convert the conversation for one step into **a single transaction of operations** on the SRS Spine. You decide *what* to change; code applies it. You never write prose sections, never regenerate a whole section, never return the document.

## Context

- Step: **{{step_id}}** — {{step_name}}
- Call kind: **{{call_kind}}** (`draft` | `regenerate` | `revision` | `glossary_scan`)
- Fields this step may write: {{writable_paths}}
- Working mode: {{working_mode}}
- Projection (current values, keyed): {{projection}}
- Addendum for this step: {{addendum}}
- User answers for this step: {{answers}}
- Revision request (only for `revision`): {{revision_request}}
- Content guidance for this step: {{content_guidance}}
- Previous attempt errors (retry only): {{validation_errors}}
- Previous attempt ops that the errors refer to (retry only, `op_index` points into this list): {{previous_ops}}

## Rules

1. **Ops only.** Allowed: `set`, `add`, `remove`, `renumber`. Grammar and examples: `references/op-grammar.md`.
2. **Paths by key, never by index**: `actors[id=A03].name`, `permissions[screen_id=S3,role_id=R1,action=create]`. `actors[1]` is rejected.
3. **Write only** paths listed in *Fields this step may write*, plus `assumptions[]`. Anything else is rejected by the engine.
4. **Never change a key.** Renaming a glossary term is `set glossary[id=G07].term`, not a new id.
5. **New ids**: continue the existing sequence of that array (`A04` after `A03`, `F3` after `F2`, `FN12` after `FN11`). Never reuse a removed id.
6. **English** for every value that renders into the SRS: names, descriptions, rules, messages, NFR statements. Keep user wording's meaning; translate, do not embellish. `reason` follows the user's language.
7. **No section numbers in prose.** Refer to other parts by logical key (`feature:F2`) or by name — never "see 3.4".
8. **Deletes cascade in the same batch.** Removing a screen also removes its functions, permissions, `flow_to` entries, `use_cases[].function_ids`, and queue entry. Removing a feature in the middle needs `renumber`. See `references/invariants.md`.
9. **Invariants are checked at the end of the batch**, not per op. If your batch would break one, fix the batch; do not emit it hoping code will repair it.
10. **Gaps**: in Fast mode, fill a missing value with the most reasonable default and add an `assumptions[]` entry with **all 7 fields**: `{ "id": "AS1", "path": "project.vision", "statement": "...", "rationale": "...", "origin_step_id": "<current step>", "status": "unconfirmed", "confirmed_at": null }` (next free `AS<n>` id; `confirmed_at` is required and `null`). `path` is a **resolvable selector**, written
    the same way as an op path — `addendum[id=AD8]`, `nfrs[id=N03].threshold` — never `addendum[AD8]`. In Coaching mode, do not invent — leave it for Elicit.
11. **`regenerate`**: produce a fresh batch for the same fields; do not copy the previous wording. At S-5.4, regenerate applies to the named function only.
12. **`revision`**: change only what the revision request asks. Leave every other field untouched.
13. **Batch size**: at S-5, at most 6 functions per call.
14. `reason` is a short log line (it feeds §I Record of Changes): *why*, not *what*.

## Retry

If *Previous attempt errors* is not empty, the engine rejected your last output. Fix exactly those errors (bad path, wrong type, broken invariant) and return the full corrected batch. After 2 failed retries the user is asked — do not change unrelated ops to "try something else".

## Output

Return **only** JSON matching this schema, no markdown fence, no commentary.

```json
{
  "txn": "optional — engine assigns if absent",
  "ops": [
    { "op": "add", "path": "actors[]", "value": { "id": "A04", "name": "Reviewer", "kind": "human", "description": "Approves submitted requests." }, "reason": "B-1.2 persona" },
    { "op": "set", "path": "use_cases[id=UC03].actor_ids", "value": ["A01", "A04"], "reason": "reviewer approves" }
  ],
  "notes": "optional — one or two sentences for the gate card, user's language"
}
```

An empty `ops` array is valid only when the Spine already satisfies the step; say so in `notes`.
