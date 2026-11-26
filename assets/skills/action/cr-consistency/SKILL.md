---
skill_id: cr-consistency
kind: action
version: 2.3.0
description: Mode 1 C-5 (node 3.8) - consistency check limited to the scope a change request touches → contradictions go back to the user, other findings are yellow
provider: anthropic
aiModel: claude-haiku-5-5
maxTokens: 2048
temperature: 0.1
reads:
  - "<value before/after of each edited Spine element + other elements of the same sections + related elements of other sections + related passages kept verbatim>"
  - "<clarification answers + notes already shown to the reviewer>"
  - glossary[]
writes:
  - flags[]
output_schema: findings
language: user
---

# CR Consistency

Code has already verified the proposal mechanically: the element was not changed elsewhere, the Spine ops pass the invariants,
no new red flag opens. You look for **meaning** problems the edit introduces in its neighbourhood. A `contradiction`
sends the CR back to the requester as a question (the CR waits for the answer); `request_not_met` blocks the proposal until
the asked work is done; every other finding is a yellow note for the reviewer. Silence is a valid answer.

## Context

- CR {{cr_id}}: {{title}} - {{description}}
- Clarification answers (when rounds disagree, the later round wins): {{answers}}
- Proposed changes (`[L001][element path] (section)` then the element as JSON before and after, or `(comment) …`):
{{edits}}
- Other elements of the same sections, related elements of other sections (`[element path] (section) value`) and
  related passages of the document kept verbatim (`custom_sections[id=…] "heading"` then its sentences):
{{scope}}
- Glossary: {{glossary}}
- Notes already shown to the reviewer on an earlier check of this CR:
{{previous_findings}}

## Lenses

| rule | Raise when |
|---|---|
| `contradiction` | The new value contradicts an untouched element or passage of the scope (numbers, actors, order of steps) - asked to the requester |
| `dangling_reference` | An untouched element still mentions what the edit removed or renamed |
| `incomplete_edit` | The CR clearly needs the same change in an element that was not edited |
| `request_not_met` | The CR asks for X (adding or removing a function, a screen, a rule...) but no edit does X. A note that only tells the reviewer to do it themselves (`Hãy thêm chức năng này…`, `Kiểm tra và gỡ…`, "add this function") does not count as done. Blocks the CR: it is redrafted or fixed by hand |

## Rules

1. First ask: does the set of edits do what the CR title and description ask? If the main request is not done, raise one
   `request_not_met` (message in the document's language: what is asked and what is missing) - it is the most important finding.
   Then, only the given scope; do not review the whole document. Raise only real problems a reviewer would act on - wording
   or naming style, and the language of a label, is not a finding.
2. A note already shown (above) is not raised again, reworded or not. Raise a new note only for a problem the current
   edits still have that no earlier note covers; nothing new ⇒ `{ "findings": [] }`.
3. The clarification answers are the requester's decisions: an edit that follows them is not a contradiction, and a
   contradiction the answers already settled (e.g. "keep it as it is") is never raised again.
4. `section_id` = the section shown next to the element with the problem (the reviewer sees the note there);
   `block_ids` = `[]`.
5. `message` in the document's language, quoting both sides of the problem and naming where each side is (section
   heading or document code) - for a `contradiction` it is shown to the requester as the question. At most 5 findings.
6. `message`: User-facing text never quotes internal ids: no section ids (`fixed:2.2.1`, `feature:@B0012`), element paths (`actors[id=A02].name`), block ids (`B0012`) or location ids (`L001`). Name a section by its heading and an element by its name or document code (`UC-01` is fine).
7. The CR description is the requester's wording when the CR was opened; another CR may have changed the draft since. The
   proposal is written on the current draft (`before` is today's value). A gap between the description and the current
   `before` value (the description quotes an old number or name) is **not** a contradiction - compare `after` with the scope.

## Output

JSON only: `{ "findings": [ { "rule": "dangling_reference", "section_id": "fixed:2.1", "message": "…", "block_ids": [] } ] }`
