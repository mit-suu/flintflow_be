---
skill_id: srs-orchestrator
kind: action
version: 1.0.0
description: Global state machine B-0 → S-9 — owns progress, working_mode, step order and the S-5 screen loop
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 1024
temperature: 0
reads:
  - project.working_mode
  - progress
  - steps[]
  - screens[].detail_status
  - screens[].queue_order
  - flags[]
  - sessions[]
writes:
  - progress
  - steps[]
output_schema: none
language: user
---

# SRS Orchestrator

Deterministic contract for the step runner (T13). **No model call.** It decides which step runs next, when a phase opens or closes, and which action (Elicit → Draft → Render → Review → Gate → Meter) is due. Every other action skill is invoked from here.

## Hierarchy

- **Phase** (`B-0`…`B-2`, `S-1`…`S-9`) — milestone; opens with Intake, closes with the `[A]/[P]/[C]` menu.
- **Step** (`<phase>.<n>`, S-5 uses `S-5.<n>@<screen_id>` and `S-5.<n>@nonscreen`) — the unit of commit and of progress.
- **Section** — rendered from Spine fields. A step never writes a section.

Full step list: `references/step-table.md` (51 fixed steps + 5 × N). That table is the only source for step ids.

## State

| Field | Meaning |
| --- | --- |
| `progress.current_phase`, `current_step` | Cursor. Belongs to the **project**, not the session |
| `progress.screen_queue[]`, `screen_cursor` | Fixed at S-4.1; S-5 pops from here |
| `progress.elicit_turns_this_phase` | Fast-path turn counter; survives resume |
| `steps[].status` | `pending` → `in_progress` → `accepted` \| `revision_requested` |
| `steps[].first_seq`, `last_seq` | Range of `changes[]` written by the step |

Only the session with `sessions[].is_pipeline = true` may advance the cursor. Other sessions may only emit change ops (`apply-change-op`).

## Per-step loop

```text
1. mark steps[id].status = in_progress, remember first_seq
2. Elicit   → elicit-loop        (skip if phase-intake reports no missing field)
3. Draft    → draft-to-ops       (one transaction, base_version = spine_version)
4. Render   → renderer/<kind>    (only steps that own a diagram)
5. Review   → deterministic-check (+ review-section when the lens is enabled)
6. Gate     → gate-check
7. Meter    → meter              (after every model call, not per step)
8. on Accept: status = accepted, accepted_at = now, last_seq, reset call counters
```

Deterministic steps **S-8.2, S-8.3, S-9.1, S-9.5** skip Elicit/Draft and never Meter.

## Phase rules

- **Intake once** at phase start (`phase-intake`), not per step.
- **Fast path**: at most 2 Elicit turns for the whole phase, drafts fill gaps with `assumptions[]`, gate is **once at phase end**.
- **Coaching path**: at least one Elicit turn per step, gate per step.
- `working_mode` may change only at a phase boundary (menu `[C]`), written to `changes[]`.
- B-0 and S-1 are **soft** phases: steps may be skipped when Intake finds the fields already filled.

## S-5 screen loop

```text
S-5.1  take first screen in screen_queue with detail_status = pending
       none left → one final round S-5.*@nonscreen for functions[screen_id=null]
S-5.2 … S-5.4  run for that screen (≤ 6 functions per model call)
S-5.5  Accept → detail_status = signed_off → back to S-5.1
```

`placeholder` screens are **not** pending. N = number of screens (+1 if any non-screen function); N is unknown before S-4.1, so progress shows phases only until then.

## S-9 final gate

Red flags with `resolved_at = null` and `waived_by_user = false` > 0 ⇒ jump to the `remediation_step` of the first open flag. Otherwise S-9.5 re-runs the deterministic check on the current `spine_version`; if the version moved between check and sign-off, reject and re-check.

## Resume

Opening a project whose current step is `in_progress`: revert `changes[first_seq..last_seq]` using `changes[].before`, then re-run the step. Reuse the user's Elicit answers from the transcript; do not ask again.

## Refuse

- Advancing from a non-pipeline session.
- Skipping a fixed phase (S-2…S-8) — the FPT template is a contract.
- Any percentage threshold for baseline. Gate on named red flags only.
