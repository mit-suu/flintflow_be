# Choosing `validations[].kind`

> Human-facing reference. **Not loaded at runtime** — the operative table is in `../SKILL.md`.

Three kinds only (`spine.types.ts` `ValidationKind`): `required`, `format`, `business`.

| Question | Answer | `kind` |
| --- | --- | --- |
| Can the value be absent? | No | `required` |
| Is the rule about the value's shape, type, range or length? | Yes | `format` |
| Would a business person argue about the rule in a meeting? | Yes | `business` |

## Why the split matters downstream

`S-7.1 Business Rules` derives `business_rules[tier=detail]` **only** from
`validations[kind=business]`, carrying the validation id in `source_validation_ids`. A domain policy
filed as `format` never reaches §5.1 Business Rules, and the traceability map has no edge from the rule
back to the function that enforces it.

The reverse mistake is cheaper but still wrong: "Email must be a valid address" filed as `business`
inflates §5.1 with field-shape trivia and buries the real policies.

## Worked examples

| Statement | Kind | Why |
| --- | --- | --- |
| "Project name must not be empty." | `required` | Presence only. |
| "Project name must be at most 120 characters." | `format` | Shape/length. |
| "Password must contain a digit and a letter." | `format` | Shape, even though it sounds like policy. |
| "A project can be archived only by its owner." | `business` | Authorisation policy, could change. |
| "A free plan allows at most 3 active projects." | `business` | Commercial policy. |
| "Credits are reserved before the model call and released within 15 minutes." | `business` | Domain lifecycle. |
| "Uploaded file must be PDF, DOCX or MD." | `format` | Accepted types. |
| "Uploaded file must be under 20 MB." | `format` | Range. Note: if the limit differs per plan, it is `business`. |

The last row is the useful test: **if the threshold depends on who the user is or what they bought, it is
`business`.** If it is the same for everybody forever, it is `format`.

## Ids

`<function id>-V<n>`, numbered from 1 within the function, never reused for a different statement — the
id is what `business_rules[].source_validation_ids` points at, so renumbering breaks §5.1's references.
