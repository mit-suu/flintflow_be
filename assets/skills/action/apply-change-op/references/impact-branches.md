# Impact query and change branches — source: srs-spine.md §4, §5, §9; Phases §2.2

## Impact query

Run on `reference_fields[]` (srs-spine §4.1) **plus** the three columns Owns / Reads / Derives of the field → section map (srs-spine §4):

1. For each op path, find elements whose reference fields contain the touched key (actors → `use_cases[].actor_ids[]`, `roles[].actor_id`, …).
2. For each touched field, collect sections in any of the three columns.
3. Collect `diagrams[]` whose `source_fields` include the touched field (srs-spine §7.1).

**Known limit:** semantic dependency is not caught — changing `project.vision` affects §1 prose but no key links them. Warn heuristically only.

## Branches

| Impact | Behaviour | UC |
| --- | --- | --- |
| No field references the changed field | Apply batch, write `changes[]` | 6.2 |
| Dependents exist | Report scope → preview diff (UC 6.1) → confirm → apply → write `flags[]` on contradiction | 6.2 · 6.11 if ambiguous |
| **Baseline already exists** | «include» Impact Analysis. If red flags remain after apply, **no new baseline** — document becomes "v1.0 + unbaselined changes" | 6.8 |
| Breaks an invariant | **Reject whole batch**, return referrers | — |

UC 6.8 has `Precondition: baseline exists`. Before the first baseline every change follows UC 6.2, including late Brief edits.

## Stale

`status(s)` is a function, never stored (srs-spine §5):

```text
derived   if s ∈ {fixed:I, fixed:5.5}
stale     if some field feeding s (Owns/Reads/Derives) has changes[].seq
          greater than accepted_at of the latest step feeding s
accepted  if steps_of(s) ≠ ∅ and all are accepted
draft     otherwise
```

After reconcile a section carries `awaiting_reaccept = true` until the owner step's gate Accepts it. It is shown separately and does not count as ready.

## Reconcile

- Manual, one pass for all stale sections (automatic propagation is out of scope for round one, Phases §9.1).
- Reads **only** dependent fields; goes through preview diff; re-renders every `diagrams[]` with a mismatched `source_hash`.
- User rejects a diff ⇒ section stays `stale` ⇒ at the final gate it becomes `section_stale_at_baseline` (waivable).

## Non-pipeline sessions

Sessions with `is_pipeline = false` may only emit change ops; they never advance `progress`. Conflicting `base_version` ⇒ reject, refund credit, keep the user's answer for regeneration (Phases §4.1).

## Undo

Undo the last op (UC 6.13) = apply `changes[].before` of that op as a new transaction. Only the last op in round one.
