# Abnormal flow patterns

> Human-facing reference. **Not loaded at runtime** — the six-pattern sweep is inlined in `../SKILL.md`.

Each entry of `functions[].abnormal[]` is ONE sentence answering three things: what goes wrong, what the
system does, what the user is left with. `S-7.3 Application Messages` later derives `messages[]` (with
codes) from these, so a vague entry becomes a vague message in §5.3.

## The six patterns

**1. Invalid input.** A `validations[]` rule fails. Say which class of rule and what survives:
> "The email is not a valid address: the system highlights the field and keeps every entered value except the password."

**2. Not found / already gone.** The target was deleted, archived, or never existed:
> "The project was deleted in another session: the system returns to the dashboard and reports that the project no longer exists."

**3. Not permitted.** The role lacks the action in the S-4.3 matrix. Distinguish from "not found" only when
the product is willing to reveal existence:
> "A viewer opens the billing screen: the system denies access and offers to contact the workspace owner."

**4. Conflict.** Concurrent edit, optimistic-lock rejection, or an idempotency collision:
> "The document changed in another tab: the system rejects the write and asks the author to reload before retrying."

**5. Dependency failure.** An external system errors or times out. Always say what happens to the work —
retried, queued, or lost — and to any money or quota already committed:
> "The model provider times out: the system releases the reserved credits, keeps the previous content and offers a retry."

**6. Limit reached.** Quota, balance, rate limit, size cap:
> "The wallet balance is below the reserved amount: the system cancels the run and shows the top-up prompt."

## When a pattern does not apply

Say so in `notes` rather than silently dropping it. "Not found does not apply: the step is always taken
from the open project" is a reviewable statement; an absent row is not.

## Anti-patterns

- **Restating the validation.** `validations[]` already says the rule; `abnormal[]` says what the system
  does when it fires.
- **UI toasts as flows.** "A toast appears" is not an abnormal flow unless the state or the user's next
  option changes.
- **Implementation detail.** No HTTP status codes, no exception class names, no table names — §3 is read
  by business reviewers.
- **The catch-all.** "Any other error shows an error message" adds nothing; name the dependency instead.
