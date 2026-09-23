---
skill_id: prioritization
kind: content
version: 0.1.0
description: "S-9.4 MoSCoW priority for every function and NFR, written into functions[].priority / nfrs[].priority"
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 6144
temperature: 0.2
reads:
  - "project"
  - "functions[]"
  - "nfrs[]"
writes:
  - "functions[]"
  - "nfrs[]"
  - "assumptions[]"
output_schema: opTransaction
language: en
stub: false
---
# Prioritization

Covers **S-9.4 Requirement Prioritization** (UC 6.6–6.7). Assign MoSCoW to **every** `functions[]` and
`nfrs[]` row by `set`-ing its `priority` field. This replaces the old standalone "priority ranking" and
"scope" generators: priority now lives on the requirement itself, so §3 and §4 render a Priority column
and the choice is traceable.

Runs at the **end** of the process, when the list is complete — not while it is still growing.

## The four values

| `priority` | Means | Test |
| --- | --- | --- |
| `must` | The release is not shippable without it | Remove it and the product fails its own stated goal, or breaks the law, or cannot be used at all |
| `should` | Painful to omit, but there is a workaround for one release | A user could still finish their job, just slower or manually |
| `could` | Genuine value, first thing dropped when time runs out | Nobody is blocked if it slips |
| `wont` | Explicitly **not** in this release | A decision that it waits — not "we forgot", not "maybe later" |

## How to decide

1. **Anchor on `project.goals[]` and `release_scope.in`.** A function that realises a stated goal is
   `must` unless something else already realises it. A function nothing in the goals or scope asks for is
   at best `could`.
2. **Follow the dependency chain.** If a `must` function cannot work without another function, that other
   one is also `must` — authentication under a user-facing feature, a webhook handler under a paid plan.
3. **`project.stakes` raises the floor.** With `stakes: production` or above, the NFRs covering
   reliability, performance and security move up: at least one reliability and one performance row is
   `must`, never `could`.
4. **Keep the mix honest.** A list where everything is `must` carries no information. Aim roughly for
   40–60 % `must`, and use `should`/`could` for the rest. If more than ~70 % genuinely must ship, say so
   in `notes` instead of silently flattening it.
5. **Non-screen functions count.** Scheduled jobs and webhook handlers are easy to forget and are often
   `must` — a payment webhook that never lands means money is lost.

## Won't-have does NOT change scope

Setting `priority: "wont"` records a judgement; it does **not** move anything into
`project.release_scope.out`. Changing the release scope is the user's decision at S-2.2, not a side
effect of ranking. So:

- Never emit an op on `project.release_scope`.
- When you mark something `wont` and the out-of-scope list does not mention it, add an `assumptions[]`
  entry (`path` = that requirement, `status: "unconfirmed"`) saying the scope line is missing. Code also
  reports this mismatch; your entry is what gives the reason.

## Say when you are guessing

MoSCoW is a business decision. You have evidence only when `project.goals[]`, `release_scope` or a business
rule points at the answer. For every item you had to **guess** — especially anything the Brief calls a goal
(a reminder mechanism that exists to cut no-shows is not a Could) — add an `assumptions[]` entry naming the
item and the level you chose, so the gate shows it with Đúng / Sửa / Bỏ instead of burying it in the
document.

## Rules

1. Cover **every** function and NFR in the projection — a row left `null` is an unfinished step.
2. `set` on `functions[id=…].priority` and `nfrs[id=…].priority` only. Do not touch names, statements,
   flows, validations, `release_scope`, or anything else.
3. Values exactly `must` | `should` | `could` | `wont`, lowercase.
4. Put the reasoning in the op's `reason` (one short clause) — it becomes the Record of Changes line.
5. English values, no diacritics (`draft-to-ops` rules 6–7).
6. Fast mode: rank with the most reasonable reading and add an `assumptions[]` entry for anything you had
   to guess; Coaching mode leaves the genuinely contested call for Elicit (`draft-to-ops` rule 10).

## Example

```json
{
  "ops": [
    { "op": "set", "path": "functions[id=FN001].priority", "value": "must", "reason": "S-9.4: authentication gates every goal in project.goals" },
    { "op": "set", "path": "functions[id=FN044].priority", "value": "should", "reason": "S-9.4: export is valuable but the document can be read in-app for one release" },
    { "op": "set", "path": "functions[id=FN051].priority", "value": "wont", "reason": "S-9.4: collaboration is out of this release" },
    { "op": "set", "path": "nfrs[id=N08].priority", "value": "must", "reason": "S-9.4: production stakes make the uptime target non-negotiable" },
    { "op": "add", "path": "assumptions[]", "value": { "id": "AS40", "path": "functions[id=FN051].priority", "statement": "Collaboration is deferred to a later release.", "rationale": "Marked Won't-have but release_scope.out does not mention it.", "origin_step_id": "S-9.4", "status": "unconfirmed", "confirmed_at": null }, "reason": "S-9.4: scope line missing for a Won't-have" }
  ],
  "notes": "58% must — concentrated in authentication, the guided pipeline and billing."
}
```

## Self-check

- [ ] Every function and every NFR in the projection got a `priority`.
- [ ] Nothing but `priority` fields (and `assumptions[]`) was written; `release_scope` untouched.
- [ ] Dependencies of a `must` are themselves `must`.
- [ ] At `stakes: production` or above, reliability and performance each have at least one `must`.
- [ ] Every `wont` without a matching `release_scope.out` line has an `assumptions[]` entry.
- [ ] The mix is informative, not "everything is must".
