---
skill_id: gate-check
kind: action
version: 1.0.0
description: Commit gate — Accept / Request revision / Regenerate / Accept as-is; caps 8 calls and 3 regenerates per step; phase menu [A]/[P]/[C]
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 1024
temperature: 0
reads:
  - steps[]
  - progress
  - project.working_mode
  - flags[]
  - usage[]
writes:
  - steps[]
  - flags[]
  - project.working_mode
output_schema: none
language: user
---

# Gate Check

Contract for `gate.service.ts` (T13) and the FE GateCard (T12). **No model call** — the user decides; code enforces caps. Actions that do call a model (`revision`, `regenerate`) route to `draft-to-ops`.

## When the gate opens

| Mode | Gate |
| --- | --- |
| Coaching | After Review of **every step** |
| Fast | **Once at the end of the phase**, covering every step of the phase |
| S-5 | Per screen at S-5.5 Screen Sign-off (both modes) |

The gate card shows: what changed (ops summary + preview diff), open flags for the fed sections, assumptions written, call counter, regenerate counter.

## Actions

| Action | Effect | Model call |
| --- | --- | :---: |
| **Accept** | `steps[].status = accepted`, `accepted_at`, close `last_seq`; resets both counters; S-5.5 sets `detail_status = signed_off` | ✘ |
| **Request revision** | `status = revision_requested`; user's text → `draft-to-ops` with call kind `revision` | ✔ |
| **Regenerate** | Revert the step's range, `draft-to-ops` with call kind `regenerate` | ✔ |
| **Accept as-is** | Only when the regenerate cap is spent **and** a revision did not solve it. Accept + write a **yellow** flag with the user's reason | ✘ |

## Caps

- **8 model calls per step**, all kinds counted: Elicit, Draft, schema retry, compile-check fix, Review, Regenerate, Request revision.
- **3 regenerates per step.** From the 4th, the Regenerate button is disabled; only Request revision remains.
- At **S-5.4**, regenerate applies at **function** level (one function), not the whole step.
- Counters reset when the step becomes `accepted`. Re-opening an accepted step starts from 0.
- A refund caused by a `base_version` conflict does **not** consume the regenerate cap.
- At 8 calls: no more model actions; the user may Accept, Accept as-is, or edit via chat after accepting.

Detail and edge cases: `references/caps-and-menu.md`.

## Phase-end menu

After the last step of a phase is accepted:

| Key | Meaning | Round one |
| --- | --- | --- |
| `[A]` | Advanced elicitation — deeper critique of the phase (BMAD `bmad-advanced-elicitation`) | cut |
| `[P]` | Party mode — multi-persona review (most expensive; warn credit first) | cut |
| `[C]` | Continue to next phase; may switch `working_mode` here (logged to `changes[]`) | ✔ |

## Refuse

- Accept while the step has a pending transaction with a stale `base_version`.
- Any percentage-based auto-accept.
- Regenerate beyond the cap, even if credit is available.
