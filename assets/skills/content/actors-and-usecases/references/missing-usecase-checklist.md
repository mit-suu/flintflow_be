# Missing use case sweep — S-3.3

Run every theme below against the current actor/use-case list. For each theme with no match, decide which
of the two it is before writing anything: a **branch of a use case that already exists** (name it in
`notes` so S-3.4 wires it as `extends`) or a **goal of its own** (add a use case). Note in `notes` — not
in the Spine — why a theme does not apply. Never silently skip.

The test for "goal of its own": would an actor deliberately open the product to do this? Yes ⇒ standalone
use case. No, it only happens part-way through another flow ⇒ a branch, and `extends` is where it belongs.

## 1. Administration

Does an admin actor have a use case for every entity type end users create? At minimum: view/list,
suspend or deactivate. If the product has no admin actor yet, that itself is a signal to revisit S-3.1
before finishing the sweep.

## 2. Support

Can any human actor reach a "something is wrong, help me" path — contact support, report an issue? If the
product is fully self-service with no support channel in scope (`release_scope.out`), note that instead of
adding a use case that contradicts scope.

## 3. Notifications

Receiving a notification is **not** a use case. The notification actor (email, SMS, push gateway) is a
participant of the use case whose flow changes a state and emits the event — "Assign Order to Driver" sends
the assignment SMS — never of a use case that only reads or displays a state ("Track Order", "View Order
Status"). Add a use case only when the recipient must then make a decision, and name it after that decision
("Respond to Failed Delivery"). Never add a passive "Receive …" or "View Notifications" use case.

## 4. Account access

Every human actor's access is decided at S-3.1 (`self-registers` · `invited` · `identity provider` · `no
sign-in`). Check the account use cases match it, with `actor_ids` = exactly the actors concerned:

| Access | Account use cases |
| --- | --- |
| `self-registers` | Register Account, Log In, Reset Password |
| `invited` | Log In, Reset Password; "Create <Actor> Account" (or "Invite …") for the actor that manages them |
| `identity provider` | Log In, with the provider `system` actor as participant; no Register/Reset |
| `no sign-in` | none |

An actor with no decided access is a S-3.1 gap: write the one combined `assumptions[]` entry, do not guess
silently.

## 5. Audit log

If the product has an admin actor and any destructive or high-trust action (delete, waive, override), is
there a use case for reviewing what happened? Absence here is common in MVPs — note it rather than
inventing scope the Brief never asked for.

## 6. Error handling

Is there a use case for a human actor recovering from a failed AI action, a validation rejection, or a
conflict (two tabs, stale data)? This is often missing because it feels like "just an error message" —
model it as a use case when the recovery involves a real decision (retry, ask a human, escalate), not for
every toast notification.

## After the sweep

Every added use case still follows `usecase-naming.md` (verb + object, full description, `function_ids:
[]`). Do not batch multiple sweep themes into one vague use case — one use case per concrete goal, same
granularity rule as S-3.2.

Forgotten password is the standing example of a **goal of its own**, not a branch: the user opens the
product precisely to recover the account, so "Reset Password" stays standalone and does not extend
"Log In".
