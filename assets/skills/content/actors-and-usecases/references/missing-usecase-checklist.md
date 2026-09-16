# Missing use case sweep — S-3.3

Run every theme below against the current actor/use-case list. For each theme, either add the missing use
case or note (in `notes`, not in the Spine) why it does not apply to this product — do not silently skip.

## 1. Administration

Does an admin actor have a use case for every entity type end users create? At minimum: view/list,
suspend or deactivate. If the product has no admin actor yet, that itself is a signal to revisit S-3.1
before finishing the sweep.

## 2. Support

Can any human actor reach a "something is wrong, help me" path — contact support, report an issue? If the
product is fully self-service with no support channel in scope (`release_scope.out`), note that instead of
adding a use case that contradicts scope.

## 3. Notifications

If any `system`/`time` actor produces an async event (job finishes, payment settles, gate opens), is
there a use case for the human actor receiving/consuming that notification?

## 4. Forgotten password / account recovery

Any product with authenticated human actors needs this unless auth is explicitly out of scope or deferred
to an external identity provider (in which case the external provider is a `system` actor and this use
case does not apply here).

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
