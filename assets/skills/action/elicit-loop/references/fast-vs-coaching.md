# Fast path vs Coaching path — source: Phases §3, §5.1, §5.3

| | Fast path | Coaching path |
| --- | --- | --- |
| Suits | "Due next week" | "Want a proper brief, no rush" |
| Elicit turns | ≤ 2 **per phase**, counted by `progress.elicit_turns_this_phase` (survives resume) | ≥ 1 per step |
| Questions | All missing fields of the phase in one grouped turn | Grouped by topic, per step |
| Thin answers | Accepted; the gap becomes an assumption | Challenged with one sharper follow-up (UC 2.6) |
| Gaps | Draft fills them and writes `assumptions[]` with `rationale` | Asked until answered |
| Gate | Once for the whole phase | Per step |
| Assumption sweep (B-2.1 / S-9.1) | Grouped by `target_section`, "Accept whole group" — except assumptions that touch an invariant or feed §4.2.2/§4.2.3, which stay individual | One by one |

`working_mode` changes only at a phase boundary (menu `[C]`) and is recorded in `changes[]`.

## What "thin" means (Coaching)

| Field | Thin | Push back with |
| --- | --- | --- |
| `actors[]` | "users", "customers", "admin" with no duty | "Who exactly does X day to day, and who approves it?" |
| `use_cases[].name` | noun only ("Report") | verb + object: "Which action — export, view, schedule a report?" |
| `nfrs[category=reliability]` | "should be stable" | "What availability % and max acceptable downtime per month?" |
| `nfrs[category=performance]` | "fast" | "Response time for which action, at how many concurrent users?" |
| `project.release_scope.out` | empty | "What will you explicitly **not** build in 1.0?" |
| `functions[].abnormal[]` | none | "What happens when the input is invalid or the service is down?" |

## Question budget examples

**Fast, S-3 with actors and use cases missing** — one turn:

1. Main user roles and what each must achieve (suggested: from B-1.2 personas).
2. External systems the product talks to.
3. Admin / support / notification duties (Missing Use Case Sweep).

**Coaching, S-6.3 Reliability** — one step, one topic:

1. Availability target (suggested: `99%`, `99.5%`, `99.9%`).
2. Max recovery time after failure (MTTR).
3. Follow-up only if the answer has no number.

## Stakes and complexity

`project.stakes` + `project.complexity` set how hard to push on §4.2.2 / §4.2.3 numbers. A student project may accept `99%`; a funded launch should not accept "best effort". Never drop the section — the FPT template is a contract.
